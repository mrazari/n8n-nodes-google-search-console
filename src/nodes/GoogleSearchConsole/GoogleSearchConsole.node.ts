import {
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  NodeOperationError,
  IDataObject,
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
    const resp = await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'googleSearchConsoleOAuth2Api', {
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

function keyFromRow(dimensions: string[], row: GscQueryRow): string {
  return (row.keys ?? []).join('||');
}

function rowsToMap(rows: GscQueryRow[], dims: string[]) {
  const m = new Map<string, GscQueryRow>();
  for (const r of rows) m.set(keyFromRow(dims, r), r);
  return m;
}

function daysInclusive(a: string, b: string): number {
  const start = new Date(a);
  const end = new Date(b);
  const msPerDay = 24 * 60 * 60 * 1000;
  const startUTC = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUTC = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.floor((endUTC - startUTC) / msPerDay) + 1;
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return toGscDate(d.toISOString());
}

function shiftYears(iso: string, years: number): string {
  const d = new Date(iso);
  d.setFullYear(d.getFullYear() + years);
  return toGscDate(d.toISOString());
}

function buildCompareRanges(
  mode: 'prevPeriod' | 'prevYear' | 'custom',
  rangeA: { startDate: string; endDate: string },
  customB?: { mode?: string; start?: string; end?: string },
) {
  if (mode === 'prevPeriod') {
    const dur = daysInclusive(rangeA.startDate, rangeA.endDate);
    const endB = shiftDays(rangeA.startDate, -1);
    const startB = shiftDays(endB, -(dur - 1));
    return { rangeA, rangeB: { startDate: startB, endDate: endB } };
  }
  if (mode === 'prevYear') {
    const startB = shiftYears(rangeA.startDate, -1);
    const endB = shiftYears(rangeA.endDate, -1);
    return { rangeA, rangeB: { startDate: startB, endDate: endB } };
  }
  const { startDate, endDate } = rangeFromPreset(customB?.mode || 'last28d', customB?.start, customB?.end);
  return { rangeA, rangeB: { startDate, endDate } };
}

function validateSiteUrlOrThrow(node: IExecuteFunctions, itemIndex: number, siteUrl: string, context: string) {
  const trimmed = (siteUrl || '').trim();
  if (!trimmed || trimmed === '__NO_SITES__') {
    throw new NodeOperationError(node.getNode(), `No site selected for ${context}.`, { itemIndex });
  }
  if (!/^https?:\/\//.test(trimmed) && !/^sc-domain:/.test(trimmed)) {
    throw new NodeOperationError(
      node.getNode(),
      'Site URL must start with http(s):// or sc-domain:. Example: https://example.com/ or sc-domain:example.com',
      { itemIndex },
    );
  }
  return trimmed;
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
    usableAsTool: true,
    defaults: { name: 'Search Console' },
    subtitle: '={{$parameter.operation}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'googleSearchConsoleOAuth2Api', required: true }],
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
          { name: 'Compare Page Insights', value: 'comparePageInsights', action: 'Compare search analytics between two date ranges' },
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
        hint: 'Enter a verified property URL. Supports domain properties via sc-domain:example.com',
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
        ],
        default: ['page'],
        displayOptions: { show: { resource: ['site'], operation: ['getPageInsights'] } },
      },

      {
        displayName: 'Filters',
        name: 'filters',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        placeholder: 'Add filter',
        displayOptions: { show: { resource: ['site'], operation: ['getPageInsights', 'comparePageInsights'] } },
        options: [{
          displayName: 'Filter',
          name: 'filter',
          values: [
            { displayName: 'Dimension', name: 'dimension', type: 'options', options: [
                { name: 'Query', value: 'query' },
                { name: 'Page', value: 'page' },
              ], default: 'query' },
            { displayName: 'Operator', name: 'operator', type: 'options', options: [
                { name: 'Equals', value: 'equals' },
                { name: 'Contains', value: 'contains' },
                { name: 'Not Equals', value: 'notEquals' },
                { name: 'Not Contains', value: 'notContains' },
                { name: 'Including Regex', value: 'includingRegex' },
                { name: 'Excluding Regex', value: 'excludingRegex' },
              ], default: 'contains' },
            { displayName: 'Combine Values With', name: 'valuesJoin', type: 'options', options: [
                { name: 'OR (any match)', value: 'or' },
                { name: 'AND (all match)', value: 'and' },
              ], default: 'or' },
            { displayName: 'Expression(s)', name: 'expression', type: 'string', default: '', placeholder: 'e.g. /blog/, summer sale (comma-separated for multiple)' },
          ],
        }],
        description: 'Add one or more filters like in the Search Console UI. Each filter becomes a filter group; groups are ANDed together.',
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
        hint: 'Supports sc-domain:example.com for domain properties',
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

      /* ---------- comparePageInsights ---------- */
      {
        displayName: 'Site URL Mode',
        name: 'siteUrlModeCompare',
        type: 'options',
        options: [
          { name: 'Pick from My Verified Sites', value: 'list' },
          { name: 'Enter Manually', value: 'manual' },
        ],
        default: 'list',
        displayOptions: { show: { resource: ['site'], operation: ['comparePageInsights'] } },
      },
      {
        displayName: 'Site URL',
        name: 'siteUrlCompare',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getVerifiedSites' },
        displayOptions: {
          show: { resource: ['site'], operation: ['comparePageInsights'], siteUrlModeCompare: ['list'] },
        },
        default: '',
        required: true,
      },
      {
        displayName: 'Site URL (Manual)',
        name: 'siteUrlCompareManual',
        type: 'string',
        placeholder: 'https://example.com/ or sc-domain:example.com',
        hint: 'Enter a verified property URL (supports sc-domain:example.com)',
        displayOptions: {
          show: { resource: ['site'], operation: ['comparePageInsights'], siteUrlModeCompare: ['manual'] },
        },
        default: '',
        required: true,
      },

      /* ---- Range A ---- */
      {
        displayName: 'Date Range A',
        name: 'dateRangeModeA',
        type: 'options',
        options: [
          { name: 'Last 7 Days', value: 'last7d' },
          { name: 'Last 28 Days', value: 'last28d' },
          { name: 'Last 3 Months', value: 'last3mo' },
          { name: 'Last 12 Months', value: 'last12mo' },
          { name: 'Custom', value: 'custom' },
        ],
        default: 'last28d',
        displayOptions: { show: { resource: ['site'], operation: ['comparePageInsights'] } },
      },
      {
        displayName: 'Start Date A',
        name: 'startDateA',
        type: 'dateTime',
        displayOptions: { show: { resource: ['site'], operation: ['comparePageInsights'], dateRangeModeA: ['custom'] } },
        default: '',
      },
      {
        displayName: 'End Date A',
        name: 'endDateA',
        type: 'dateTime',
        displayOptions: { show: { resource: ['site'], operation: ['comparePageInsights'], dateRangeModeA: ['custom'] } },
        default: '',
      },
      {
        displayName: 'Compare Mode',
        name: 'compareMode',
        type: 'options',
        options: [
          { name: 'Previous Period', value: 'prevPeriod' },
          { name: 'Previous Year (YoY)', value: 'prevYear' },
          { name: 'Custom', value: 'custom' },
        ],
        default: 'prevPeriod',
        displayOptions: { show: { resource: ['site'], operation: ['comparePageInsights'] } },
      },

      /* ---- Range B (only when compare is custom) ---- */
      {
        displayName: 'Date Range B',
        name: 'dateRangeModeB',
        type: 'options',
        options: [
          { name: 'Last 7 Days', value: 'last7d' },
          { name: 'Last 28 Days', value: 'last28d' },
          { name: 'Last 3 Months', value: 'last3mo' },
          { name: 'Last 12 Months', value: 'last12mo' },
          { name: 'Custom', value: 'custom' },
        ],
        default: 'last28d',
        displayOptions: { show: { resource: ['site'], operation: ['comparePageInsights'], compareMode: ['custom'] } },
      },
      {
        displayName: 'Start Date B',
        name: 'startDateB',
        type: 'dateTime',
        displayOptions: {
          show: { resource: ['site'], operation: ['comparePageInsights'], compareMode: ['custom'], dateRangeModeB: ['custom'] },
        },
        default: '',
      },
      {
        displayName: 'End Date B',
        name: 'endDateB',
        type: 'dateTime',
        displayOptions: {
          show: { resource: ['site'], operation: ['comparePageInsights'], compareMode: ['custom'], dateRangeModeB: ['custom'] },
        },
        default: '',
      },

      /* ---- Shared options ---- */
      {
        displayName: 'Row Limit (per range)',
        name: 'rowLimitCompare',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 25000 },
        default: 1000,
        displayOptions: { show: { resource: ['site'], operation: ['comparePageInsights'] } },
      },
      {
        displayName: 'Search Type',
        name: 'searchTypeCompare',
        type: 'options',
        options: [
          { name: 'Web', value: 'web' },
          { name: 'Image', value: 'image' },
          { name: 'Video', value: 'video' },
          { name: 'News', value: 'news' },
        ],
        default: 'web',
        displayOptions: { show: { resource: ['site'], operation: ['comparePageInsights'] } },
      },
      {
        displayName: 'Dimensions',
        name: 'dimensionsCompare',
        type: 'multiOptions',
        options: [
          { name: 'Date', value: 'date' },
          { name: 'Page', value: 'page' },
          { name: 'Query', value: 'query' },
        ],
        default: ['page'],
        displayOptions: { show: { resource: ['site'], operation: ['comparePageInsights'] } },
      },
    ],
  };

  methods = {
    loadOptions: {
      async getVerifiedSites(this: ILoadOptionsFunctions) {
        try {
          const resp = await this.helpers.httpRequestWithAuthentication.call(
            this,
            'googleSearchConsoleOAuth2Api',
            { method: 'GET', url: 'https://www.googleapis.com/webmasters/v3/sites' },
          );
          const sites: GscSiteEntry[] = Array.isArray(resp?.siteEntry) ? resp.siteEntry : [];
          if (!sites.length) {
            return [{
              name: 'No verified properties found — verify your site in Google Search Console first.',
              value: '__NO_SITES__',
            }];
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
          return [{
            name: `Error loading sites: ${err?.message || 'Failed to load sites. Check your OAuth credentials/permissions.'}`,
            value: '__NO_SITES__',
          }];
        }
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const operation = this.getNodeParameter('operation', i) as string;
      
      // استفاده از continueOnFail() به جای this.continueOnFail()
      const continueOnFail = this.getNodeParameter('continueOnFail', i, false) as boolean;
      
      const pushOk = (json: any) => returnData.push({ json, pairedItem: { item: i } });
      const pushErr = (e: unknown) => { 
        if (continueOnFail) {
          pushOk({ error: (e as Error)?.message ?? e });
        } else {
          throw e;
        }
      };

      try {
        // Build dimensionFilterGroups (per item) from Filters
        const filtersCollection = this.getNodeParameter('filters.filter', i, []) as IDataObject[];
        const dimensionFilterGroups: IDataObject[] = [];
        const makeFilter = (dimension: string, operator: string, expression: string) => ({ dimension, operator, expression });

        if (Array.isArray(filtersCollection) && filtersCollection.length) {
          for (const f of filtersCollection) {
            const dimension = (f as any).dimension as string;
            if (dimension !== 'page' && dimension !== 'query') continue;
            const operator = ((f as any).operator as string) || 'contains';
            const valuesJoin = ((f as any).valuesJoin as string) || 'or';
            const exprRaw = (((f as any).expression as string) || '').trim();
            let values: string[] = [];

            if (exprRaw) {
              values = exprRaw.split(',').map(v => v.trim()).filter(Boolean);
            }

            if (values.length === 1) {
              dimensionFilterGroups.push({ groupType: 'and', filters: [ makeFilter(dimension, operator, values[0]) ] } as IDataObject);
            } else if (values.length > 1) {
              dimensionFilterGroups.push({ groupType: valuesJoin, filters: values.map(v => makeFilter(dimension, operator, v)) } as IDataObject);
            }
          }
        }
        
        if (operation === 'getSites') {
          const resp = await this.helpers.httpRequestWithAuthentication.call(
            this,
            'googleSearchConsoleOAuth2Api',
            { method: 'GET', url: 'https://www.googleapis.com/webmasters/v3/sites' },
          );
          const sites: GscSiteEntry[] = Array.isArray(resp?.siteEntry) ? resp.siteEntry : [];
          // فقط بازگرداندن داده‌های API بدون اضافه کردن resource و operation
          sites.forEach((s) => pushOk(s));
        }

        if (operation === 'getPageInsights') {
          const siteUrlMode = this.getNodeParameter('siteUrlMode', i) as string;
          const siteUrlInput = siteUrlMode === 'manual'
            ? (this.getNodeParameter('siteUrlManual', i) as string)
            : (this.getNodeParameter('siteUrl', i) as string);

          const siteUrl = validateSiteUrlOrThrow(this, i, siteUrlInput, 'page insights');

          const dateRangeMode = this.getNodeParameter('dateRangeMode', i) as string;
          const startDateParam = this.getNodeParameter('startDate', i, '') as string;
          const endDateParam = this.getNodeParameter('endDate', i, '') as string;
          const { startDate, endDate } = rangeFromPreset(dateRangeMode, startDateParam, endDateParam);

          const rowLimit = this.getNodeParameter('rowLimit', i) as number;
          const searchType = this.getNodeParameter('searchType', i) as string;
          const dimensions = this.getNodeParameter('dimensions', i) as string[];

          const body = {
            ...(dimensionFilterGroups.length ? { dimensionFilterGroups } : {}),
            startDate,
            endDate,
            dimensions,
            rowLimit: Math.max(1, Math.min(rowLimit, 25000)),
            searchType
          };
          const rows = await fetchAllRows(this, siteUrl, body, rowLimit);
          // فقط بازگرداندن داده‌های API بدون اضافه کردن resource و operation
          rows.forEach((r) => pushOk(mapRow(dimensions, r)));
        }

        if (operation === 'inspectUrl') {
          const siteUrlMode = this.getNodeParameter('inspectSiteUrlMode', i) as string;
          const siteUrlInput = siteUrlMode === 'manual'
            ? (this.getNodeParameter('inspectSiteUrlManual', i) as string)
            : (this.getNodeParameter('inspectSiteUrl', i) as string);

          const siteUrl = validateSiteUrlOrThrow(this, i, siteUrlInput, 'URL inspection');

          const inspectionUrl = (this.getNodeParameter('inspectionUrl', i) as string).trim();
          if (!/^https?:\/\//.test(inspectionUrl)) {
            throw new NodeOperationError(this.getNode(), 'Inspection URL must start with http(s)://', { itemIndex: i });
          }

          const languageCode = (this.getNodeParameter('languageCode', i) as string) || '';

          const resp = await this.helpers.httpRequestWithAuthentication.call(
            this,
            'googleSearchConsoleOAuth2Api',
            {
              method: 'POST',
              url: 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
              body: { inspectionUrl, siteUrl, languageCode: languageCode || undefined },
            },
          );
          // فقط بازگرداندن داده‌های API
          const result = resp?.inspectionResult || {};
          pushOk(result);
        }

        /* ---------- Compare Page Insights ---------- */
        if (operation === 'comparePageInsights') {
          const mode = (this.getNodeParameter('siteUrlModeCompare', i) as string) || 'list';
          const siteUrlInput = mode === 'manual'
            ? (this.getNodeParameter('siteUrlCompareManual', i) as string)
            : (this.getNodeParameter('siteUrlCompare', i) as string);

          const siteUrl = validateSiteUrlOrThrow(this, i, siteUrlInput, 'comparison');

          const dims = (this.getNodeParameter('dimensionsCompare', i) as string[]) || ['page'];
          if (!dims.length) {
            throw new NodeOperationError(this.getNode(), 'At least one dimension is required for comparison.', { itemIndex: i });
          }

          // Range A (preset/custom)
          const drmA   = (this.getNodeParameter('dateRangeModeA', i) as string) || 'last28d';
          const startA = (this.getNodeParameter('startDateA', i, '') as string) || '';
          const endA   = (this.getNodeParameter('endDateA', i, '') as string) || '';
          const rangeA = rangeFromPreset(drmA, startA, endA);

          // Compare mode: prevPeriod / prevYear / custom
          const compareMode = (this.getNodeParameter('compareMode', i) as 'prevPeriod' | 'prevYear' | 'custom') || 'prevPeriod';

          // اگر Custom انتخاب شده، پارامترهای B را بخوان
          let customB: { mode?: string; start?: string; end?: string } | undefined;
          if (compareMode === 'custom') {
            const drmB   = (this.getNodeParameter('dateRangeModeB', i) as string) || 'last28d';
            const startB = (this.getNodeParameter('startDateB', i, '') as string) || '';
            const endB   = (this.getNodeParameter('endDateB', i, '') as string) || '';
            customB = { mode: drmB, start: startB, end: endB };
          }

          const { rangeB } = buildCompareRanges(compareMode, rangeA, customB);

          const rowLimit   = ((this.getNodeParameter('rowLimitCompare', i) as number) || 1000);
          const searchType = (this.getNodeParameter('searchTypeCompare', i) as string) || 'web';
          const baseBody = {
            dimensions: dims,
            searchType,
            ...(dimensionFilterGroups.length ? { dimensionFilterGroups } : {}),
          };

          const rowsA = await fetchAllRows(this, siteUrl, { ...baseBody, ...rangeA }, rowLimit);
          const rowsB = await fetchAllRows(this, siteUrl, { ...baseBody, ...rangeB }, rowLimit);

          const mapA = rowsToMap(rowsA, dims);
          const mapB = rowsToMap(rowsB, dims);
          const allKeys = new Set<string>([...mapA.keys(), ...mapB.keys()]);

          for (const k of allKeys) {
            const ra = mapA.get(k);
            const rb = mapB.get(k);

            const emptyFrom = (keys?: string[]): GscQueryRow => ({
              keys: keys ?? [], clicks: 0, impressions: 0, ctr: 0, position: 0,
            });

            const valsA: GscQueryRow = ra ?? emptyFrom(ra?.keys ?? rb?.keys);
            const valsB: GscQueryRow = rb ?? emptyFrom(rb?.keys ?? ra?.keys);

            const out: Record<string, any> = {};
            (valsA.keys ?? valsB.keys ?? []).forEach((v: string, idx: number) => { out[dims[idx]] = v; });

            out.clicks_a = valsA.clicks;         out.clicks_b = valsB.clicks;         out.clicks_diff = valsA.clicks - valsB.clicks;
            out.impr_a   = valsA.impressions;    out.impr_b   = valsB.impressions;    out.impr_diff   = valsA.impressions - valsB.impressions;
            out.ctr_a    = valsA.ctr;            out.ctr_b    = valsB.ctr;            out.ctr_diff    = valsA.ctr - valsB.ctr;
            out.pos_a    = valsA.position;       out.pos_b    = valsB.position;       out.pos_diff    = valsA.position - valsB.position;

            out.range_a = rangeA;
            out.range_b = rangeB;
            out.compare_mode = compareMode;

            // فقط بازگرداندن داده‌های پردازش شده بدون resource و operation
            returnData.push({ json: out, pairedItem: { item: i } });
          }
        }

      } catch (error) {
        pushErr(error);
      }
    }
    return [returnData];
  }
}