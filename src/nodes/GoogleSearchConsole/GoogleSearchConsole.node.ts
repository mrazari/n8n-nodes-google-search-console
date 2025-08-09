import {
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  IExecuteFunctions,
  NodeOperationError,
} from 'n8n-workflow';

/* ========= Helpers (module-scope) ========= */
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

function defaultedRange(start?: string, end?: string): { startDate: string; endDate: string } {
  const endDt = end ? new Date(end) : new Date();
  const startDt = start ? new Date(start) : new Date(endDt.getTime() - 28 * 86400000);
  const s = toGscDate(start ?? startDt.toISOString());
  const e = toGscDate(end ?? endDt.toISOString());
  return { startDate: s, endDate: e };
}

function mapRow(dimensions: string[], row: GscQueryRow) {
  const obj: Record<string, any> = {};
  if (Array.isArray(row.keys)) {
    dimensions.forEach((d, idx) => {
      obj[d] = row.keys![idx];
    });
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
    methods: {
      resourceOperations: {
        site: ['getSites', 'getPageInsights', 'inspectUrl'],
      },
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

      /* ---------- getPageInsights (manual site) ---------- */
      {
        displayName: 'Site URL',
        name: 'siteUrl',
        type: 'string',
        placeholder: 'https://example.com/ or sc-domain:example.com',
        hint: 'Enter your verified property URL.',
        displayOptions: { show: { resource: ['site'], operation: ['getPageInsights'] } },
        default: '',
        required: true,
      },
      {
        displayName: 'Start Date',
        name: 'startDate',
        type: 'dateTime',
        hint: 'If empty, defaults to 28 days before End Date (or today).',
        displayOptions: { show: { resource: ['site'], operation: ['getPageInsights'] } },
        default: '',
      },
      {
        displayName: 'End Date',
        name: 'endDate',
        type: 'dateTime',
        hint: 'If empty, defaults to today.',
        displayOptions: { show: { resource: ['site'], operation: ['getPageInsights'] } },
        default: '',
      },
      {
        displayName: 'Row Limit',
        name: 'rowLimit',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 25000 },
        default: 1000,
        description: 'Maximum rows to return (pagination will fetch in chunks up to this number).',
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

      /* ---------- inspectUrl (manual site) ---------- */
      {
        displayName: 'Site URL',
        name: 'inspectSiteUrl',
        type: 'string',
        placeholder: 'https://example.com/ or sc-domain:example.com',
        hint: 'Property that contains the Inspection URL (must match ownership).',
        displayOptions: { show: { resource: ['site'], operation: ['inspectUrl'] } },
        default: '',
        required: true,
      },
      {
        displayName: 'Inspection URL',
        name: 'inspectionUrl',
        type: 'string',
        placeholder: 'https://example.com/page',
        displayOptions: { show: { resource: ['site'], operation: ['inspectUrl'] } },
        default: '',
        required: true,
      },
      {
        displayName: 'Language Code',
        name: 'languageCode',
        type: 'string',
        placeholder: 'en-US',
        hint: 'Optional BCP-47 code like en-US or fa-IR.',
        displayOptions: { show: { resource: ['site'], operation: ['inspectUrl'] } },
        default: '',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const operation = this.getNodeParameter('operation', i) as string;
      const pushOk = (json: any) => returnData.push({ json, pairedItem: { item: i } });
      const pushErr = (e: unknown) => {
        if (this.continueOnFail()) {
          pushOk({ error: (e as Error)?.message ?? e });
          return;
        }
        throw e;
      };

      try {
        /* ---------- Get Sites ---------- */
        if (operation === 'getSites') {
          const resp = await this.helpers.httpRequestWithAuthentication.call(
            this,
            'GoogleSearchConsoleOAuth2Api',
            { method: 'GET', url: 'https://www.googleapis.com/webmasters/v3/sites' },
          );
          const sites: GscSiteEntry[] = Array.isArray(resp?.siteEntry) ? resp.siteEntry : [];
          sites.forEach((s) => pushOk({ resource: 'site', operation: 'getSites', ...s }));
        }

        /* ---------- Get Page Insights ---------- */
        if (operation === 'getPageInsights') {
          const siteUrl = (this.getNodeParameter('siteUrl', i) as string).trim();
          const startDateParam = this.getNodeParameter('startDate', i) as string;
          const endDateParam = this.getNodeParameter('endDate', i) as string;
          const rowLimit = (this.getNodeParameter('rowLimit', i) as number) || 1000;
          const searchType = (this.getNodeParameter('searchType', i) as string) || 'web';
          const dimensions = (this.getNodeParameter('dimensions', i) as string[]) || ['page'];

          if (!/^https?:\/\//.test(siteUrl) && !/^sc-domain:/.test(siteUrl)) {
            throw new NodeOperationError(this.getNode(), 'Site URL must start with http://, https:// or sc-domain:', { itemIndex: i });
          }

          const { startDate, endDate } = defaultedRange(startDateParam, endDateParam);
          if (!startDate || !endDate) {
            throw new NodeOperationError(this.getNode(), 'Start/End date invalid.', { itemIndex: i });
          }

          const body = {
            startDate,
            endDate,
            dimensions,
            rowLimit: Math.max(1, Math.min(rowLimit, 25000)),
            searchType,
          };

          const rows = await fetchAllRows(this, siteUrl, body, rowLimit);
          rows.forEach((r) => pushOk({ resource: 'site', operation: 'getPageInsights', ...mapRow(dimensions, r) }));
        }

        /* ---------- Inspect URL ---------- */
        if (operation === 'inspectUrl') {
          const siteUrl = (this.getNodeParameter('inspectSiteUrl', i) as string).trim();
          const inspectionUrl = (this.getNodeParameter('inspectionUrl', i) as string).trim();
          const languageCode = (this.getNodeParameter('languageCode', i) as string) || '';

          if (!/^https?:\/\//.test(inspectionUrl)) {
            throw new NodeOperationError(this.getNode(), 'Inspection URL must start with http(s)://', { itemIndex: i });
          }
          if (!/^https?:\/\//.test(siteUrl) && !/^sc-domain:/.test(siteUrl)) {
            throw new NodeOperationError(this.getNode(), 'Site URL must be a verified property.', { itemIndex: i });
          }

          const resp = await this.helpers.httpRequestWithAuthentication.call(
            this,
            'GoogleSearchConsoleOAuth2Api',
            {
              method: 'POST',
              url: 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
              body: {
                inspectionUrl,
                siteUrl,
                languageCode: languageCode || undefined,
              },
            },
          );

          const result = resp?.inspectionResult || {};
          const out = {
            resource: 'site',
            operation: 'inspectUrl',
            verdict: result?.verdict,
            indexStatusResult: result?.indexStatusResult,
            mobileUsabilityResult: result?.mobileUsabilityResult,
            richResultsResult: result?.richResultsResult,
            ampResult: result?.ampResult,
            inspectionResultLink: result?.inspectionResultLink,
          };

          pushOk(out);
        }
      } catch (error) {
        pushErr(error);
      }
    }

    return [returnData];
  }
}
