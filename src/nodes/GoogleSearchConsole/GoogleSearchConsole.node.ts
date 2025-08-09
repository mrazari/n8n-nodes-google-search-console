import {
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  NodeOperationError,
} from 'n8n-workflow';

/* ========= Helpers ========= */
type GscSiteEntry = {
  siteUrl: string;
  permissionLevel?: string;
  [extra: string]: any;
};

type GscQueryRow = {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  [extra: string]: any;
};

function toGscDate(d?: string): string {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().split('T')[0];
}

function defaultedRange(start?: string, end?: string) {
  const endDt = end ? new Date(end) : new Date();
  const startDt = start ? new Date(start) : new Date(endDt.getTime() - 28 * 86400000);
  return { startDate: toGscDate(start ?? startDt.toISOString()), endDate: toGscDate(end ?? endDt.toISOString()) };
}

function rangeFromPreset(mode: string, customStart?: string, customEnd?: string) {
  const end = customEnd ? new Date(customEnd) : new Date();
  let start = customStart ? new Date(customStart) : new Date(end);

  if (mode !== 'custom') {
    const e = new Date(end);
    const s = new Date(end);
    switch (mode) {
      case 'last7d':   s.setDate(e.getDate() - 7); break;
      case 'last28d':  s.setDate(e.getDate() - 28); break;
      case 'last3mo':  s.setMonth(e.getMonth() - 3); break;
      case 'last12mo': s.setMonth(e.getMonth() - 12); break;
      default:         s.setDate(e.getDate() - 28);
    }
    return { startDate: toGscDate(s.toISOString()), endDate: toGscDate(e.toISOString()) };
  }
  return defaultedRange(customStart, customEnd);
}

function mapRow(dimensions: string[], row: GscQueryRow) {
  const obj: Record<string, any> = {};
  if (Array.isArray(row.keys)) {
    dimensions.forEach((d, idx) => { obj[d] = row.keys![idx]; });
  }
  obj.clicks = row.clicks;
  obj.impressions = row.impressions;
  obj.ctr = row.ctr;
  obj.position = row.position;
  return obj;
}

async function fetchAllRows(
  ctx: IExecuteFunctions,
  siteUrl: string,
  body: Record<string, any>,
  targetLimit: number,
): Promise<GscQueryRow[]> {
  const rows: GscQueryRow[] = [];
  let startRow = 0;
  const perRequest = Math.max(100, Math.min(body.rowLimit ?? 1000, 25000));

  while (rows.length < targetLimit) {
    const resp = await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'GoogleSearchConsoleOAuth2Api', {
      method: 'POST',
      url: `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      body: { ...body, rowLimit: perRequest, startRow },
    });

    const chunk: GscQueryRow[] = Array.isArray(resp?.rows) ? resp.rows : [];
    if (chunk.length === 0) break;

    rows.push(...chunk);
    startRow += chunk.length;
    if (chunk.length < perRequest) break;
    if (rows.length >= targetLimit) break;
  }
  return rows.slice(0, targetLimit);
}

/* ========= Node ========= */
export class GoogleSearchConsole implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Google Search Console',
    name: 'googleSearchConsole',
    icon: 'file:googlesearchconsole.svg',
    group: ['resource'],
    version: 1,
    description: 'Connect to Google Search Console API',
    defaults: { name: 'Search Console' },
    subtitle: '={{$parameter.operation}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'GoogleSearchConsoleOAuth2Api', required: true }],
    requestDefaults: {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    },
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        options: [{ name: 'Site', value: 'site' }],
        default: 'site',
        required: true,
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        options: [
          { name: 'Get Sites', value: 'getSites', action: 'List verified sites' },
          { name: 'Get Page Insights', value: 'getPageInsights', action: 'Query search analytics' },
          { name: 'Inspect URL', value: 'inspectUrl', action: 'URL Inspection (index status)' },
        ],
        default: 'getSites',
        required: true,
        displayOptions: { show: { resource: ['site'] } },
      },

      /* ---------- getPageInsights ---------- */
      {
        displayName: 'Site URL Mode',
        name: 'siteUrlMode',
        type: 'options',
        options: [
          { name: 'Pick from My Verified Sites', value: 'list' },
          { name: 'Enter Manually', value: 'manual' },
        ],
        default: 'list',
        displayOptions: { show: { resource: ['site'], operation: ['getPageInsights'] } },
      },
      {
        displayName: 'Site URL',
        name: 'siteUrl',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getVerifiedSites' },
        displayOptions: {
          show: { resource: ['site'], operation: ['getPageInsights'], siteUrlMode: ['list'] },
        },
        default: '',
        required: true,
      },
      {
        displayName: 'Site URL (Manual)',
        name: 'siteUrlManual',
        type: 'string',
        placeholder: 'https://example.com/ or sc-domain:example.com',
        hint: 'Enter your verified property URL.',
        displayOptions: {
          show: { resource: ['site'], operation: ['getPageInsights'], siteUrlMode: ['manual'] },
        },
        default: '',
        required: true,
      },
      {
        displayName: 'Date Range',
        name: 'dateRangeMode',
        type: 'options',
        options: [
          { name: 'Last 7 Days', value: 'last7d' },
          { name: 'Last 28 Days', value: 'last28d' },
          { name: 'Last 3 Months', value: 'last3mo' },
          { name: 'Last 12 Months', value: 'last12mo' },
          { name: 'Custom', value: 'custom' },
        ],
        default: 'last28d',
        hint: 'Select preset or Custom to set exact dates.',
        displayOptions: { show: { resource: ['site'], operation: ['getPageInsights'] } },
      },
      {
        displayName: 'Start Date',
        name: 'startDate',
        type: 'dateTime',
        hint: 'Shown only if Date Range is Custom.',
        displayOptions: { show: { resource: ['site'], operation: ['getPageInsights'], dateRangeMode: ['custom'] } },
        default: '',
      },
      {
        displayName: 'End Date',
        name: 'endDate',
        type: 'dateTime',
        hint: 'Shown only if Date Range is Custom.',
        displayOptions: { show: { resource: ['site'], operation: ['getPageInsights'], dateRangeMode: ['custom'] } },
        default: '',
      },
      {
        displayName: 'Row Limit',
        name: 'rowLimit',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 25000 },
        default: 1000,
        displayOptions: { show: { resource: ['site'], operation: ['getPageInsights'] } },
      },
      {
        displayName: 'Search Type',
        name: 'searchType',
        type: 'options',
        options: [
          { name: 'Web', value: 'web' },
          { name: 'Image', value: 'image' },
          { name: 'Video', value: 'video' },
          { name: 'News', value: 'news' },
        ],
        default: 'web',
        displayOptions: { show: { resource: ['site'], operation: ['getPageInsights'] } },
      },
      {
        displayName: 'Dimensions',
        name: 'dimensions',
        type: 'multiOptions',
        options: [
          { name: 'Date', value: 'date' },
          { name: 'Page', value: 'page' },
          { name: 'Query', value: 'query' },
          { name: 'Country', value: 'country' },
          { name: 'Device', value: 'device' },
        ],
        default: ['page'],
        displayOptions: { show: { resource: ['site'], operation: ['getPageInsights'] } },
      },

      /* ---------- inspectUrl ---------- */
      {
        displayName: 'Site URL Mode',
        name: 'inspectSiteUrlMode',
        type: 'options',
        options: [
          { name: 'Pick from My Verified Sites', value: 'list' },
          { name: 'Enter Manually', value: 'manual' },
        ],
        default: 'list',
        displayOptions: { show: { resource: ['site'], operation: ['inspectUrl'] } },
      },
      {
        displayName: 'Site URL',
        name: 'inspectSiteUrl',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getVerifiedSites' },
        displayOptions: {
          show: { resource: ['site'], operation: ['inspectUrl'], inspectSiteUrlMode: ['list'] },
        },
        default: '',
        required: true,
      },
      {
        displayName: 'Site URL (Manual)',
        name: 'inspectSiteUrlManual',
        type: 'string',
        placeholder: 'https://example.com/ or sc-domain:example.com',
        displayOptions: {
          show: { resource: ['site'], operation: ['inspectUrl'], inspectSiteUrlMode: ['manual'] },
        },
        default: '',
        required: true,
      },
      {
        displayName: 'Inspection URL',
        name: 'inspectionUrl',
        type: 'string',
        displayOptions: { show: { resource: ['site'], operation: ['inspectUrl'] } },
        default: '',
        required: true,
      },
      {
        displayName: 'Language Code',
        name: 'languageCode',
        type: 'string',
        displayOptions: { show: { resource: ['site'], operation: ['inspectUrl'] } },
        default: '',
      },
    ],
  };

  methods = {
    loadOptions: {
      async getVerifiedSites(this: ILoadOptionsFunctions) {
        try {
          const resp = await this.helpers.httpRequestWithAuthentication.call(
            this,
            'GoogleSearchConsoleOAuth2Api',
            { method: 'GET', url: 'https://www.googleapis.com/webmasters/v3/sites' },
          );
          const sites: GscSiteEntry[] = Array.isArray(resp?.siteEntry) ? resp.siteEntry : [];
          if (!sites.length) {
            return [{ name: 'No verified properties found', value: '__NO_SITES__' }];
          }
          const sorted = [...sites].sort((a, b) => {
            const av = a.siteUrl.startsWith('sc-domain:') ? 0 : 1;
            const bv = b.siteUrl.startsWith('sc-domain:') ? 0 : 1;
            return av - bv || a.siteUrl.localeCompare(b.siteUrl);
          });
          return sorted.map((s) => ({
            name: `${s.siteUrl}${s.permissionLevel ? ` (${s.permissionLevel})` : ''}`,
            value: s.siteUrl,
            description: s.permissionLevel || '',
          }));
        } catch (err: any) {
          return [{ name: `Error: ${err?.message || 'Failed to load sites'}`, value: '__NO_SITES__' }];
        }
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const operation = this.getNodeParameter('operation', i) as string;
      const pushOk = (json: any) => returnData.push({ json, pairedItem: { item: i } });
      const pushErr = (e: unknown) => { if (this.continueOnFail()) pushOk({ error: (e as Error)?.message ?? e }); else throw e; };

      try {
        if (operation === 'getSites') {
          const resp = await this.helpers.httpRequestWithAuthentication.call(
            this,
            'GoogleSearchConsoleOAuth2Api',
            { method: 'GET', url: 'https://www.googleapis.com/webmasters/v3/sites' },
          );
          const sites: GscSiteEntry[] = Array.isArray(resp?.siteEntry) ? resp.siteEntry : [];
          sites.forEach((s) => pushOk({ resource: 'site', operation: 'getSites', ...s }));
        }

        if (operation === 'getPageInsights') {
          const siteUrlMode = this.getNodeParameter('siteUrlMode', i) as string;
          const siteUrl = siteUrlMode === 'manual'
            ? (this.getNodeParameter('siteUrlManual', i) as string).trim()
            : (this.getNodeParameter('siteUrl', i) as string).trim();

          if (!siteUrl || siteUrl === '__NO_SITES__') throw new NodeOperationError(this.getNode(), 'No site selected.', { itemIndex: i });

          const dateRangeMode = this.getNodeParameter('dateRangeMode', i) as string;
          const startDateParam = this.getNodeParameter('startDate', i, '') as string;
          const endDateParam = this.getNodeParameter('endDate', i, '') as string;
          const { startDate, endDate } = rangeFromPreset(dateRangeMode, startDateParam, endDateParam);

          const rowLimit = this.getNodeParameter('rowLimit', i) as number;
          const searchType = this.getNodeParameter('searchType', i) as string;
          const dimensions = this.getNodeParameter('dimensions', i) as string[];

          const body = { startDate, endDate, dimensions, rowLimit: Math.max(1, Math.min(rowLimit, 25000)), searchType };
          const rows = await fetchAllRows(this, siteUrl, body, rowLimit);
          rows.forEach((r) => pushOk({ resource: 'site', operation: 'getPageInsights', ...mapRow(dimensions, r) }));
        }

        if (operation === 'inspectUrl') {
          const siteUrlMode = this.getNodeParameter('inspectSiteUrlMode', i) as string;
          const siteUrl = siteUrlMode === 'manual'
            ? (this.getNodeParameter('inspectSiteUrlManual', i) as string).trim()
            : (this.getNodeParameter('inspectSiteUrl', i) as string).trim();
          const inspectionUrl = (this.getNodeParameter('inspectionUrl', i) as string).trim();
          const languageCode = (this.getNodeParameter('languageCode', i) as string) || '';

          const resp = await this.helpers.httpRequestWithAuthentication.call(
            this,
            'GoogleSearchConsoleOAuth2Api',
            {
              method: 'POST',
              url: 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
              body: { inspectionUrl, siteUrl, languageCode: languageCode || undefined },
            },
          );
          const result = resp?.inspectionResult || {};
          pushOk({ resource: 'site', operation: 'inspectUrl', ...result });
        }
      } catch (error) {
        pushErr(error);
      }
    }
    return [returnData];
  }
}
