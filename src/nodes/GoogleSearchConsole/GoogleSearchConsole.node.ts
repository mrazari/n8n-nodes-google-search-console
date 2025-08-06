import {
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IExecuteFunctions,
	NodeOperationError,
} from 'n8n-workflow';

export class GoogleSearchConsole implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Google Search Console',
		name: 'googleSearchConsole',
		icon: 'file:googlesearchconsole.svg',
		group: ['resource'],
		version: 1,
		description: 'Connect to Google Search Console API',
		defaults: {
			name: 'Search Console',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'GoogleSearchConsoleOAuth2Api',
				required: true,
			},
		],
		requestDefaults: {
			baseURL: 'https://www.googleapis.com/webmasters/v3',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
		},
		methods: {
			loadOptions: {},
			resourceOperations: {
				site: ['getSites', 'getPageInsights'],
			},
		},
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				options: [
					{ name: 'Site', value: 'site' },
				],
				default: 'site',
				required: true,
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				options: [
					{
						name: 'Get Sites',
						value: 'getSites',
					},
					{
						name: 'Get Page Insights',
						value: 'getPageInsights',
					},
				],
				default: 'getSites',
				required: true,
				displayOptions: {
					show: {
						resource: ['site'],
					},
				},
			},
			{
				displayName: 'Site URL',
				name: 'siteUrl',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['site'],
						operation: ['getPageInsights'],
					},
				},
				default: '',
				required: true,
			},
			{
				displayName: 'Start Date',
				name: 'startDate',
				type: 'dateTime',
				displayOptions: {
					show: {
						resource: ['site'],
						operation: ['getPageInsights'],
					},
				},
				default: '',
			},
			{
				displayName: 'End Date',
				name: 'endDate',
				type: 'dateTime',
				displayOptions: {
					show: {
						resource: ['site'],
						operation: ['getPageInsights'],
					},
				},
				default: '',
			},
			{
				displayName: 'Row Limit',
				name: 'rowLimit',
				type: 'number',
				default: 10,
				description: 'Number of rows to return',
				displayOptions: {
					show: {
						resource: ['site'],
						operation: ['getPageInsights'],
					},
				},
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
				displayOptions: {
					show: {
						resource: ['site'],
						operation: ['getPageInsights'],
					},
				},
			},
			{
				displayName: 'Dimensions',
				name: 'dimensions',
				type: 'multiOptions',
				options: [
					{ name: 'Page', value: 'page' },
					{ name: 'Query', value: 'query' },
					{ name: 'Country', value: 'country' },
					{ name: 'Device', value: 'device' },
				],
				default: ['page'],
				displayOptions: {
					show: {
						resource: ['site'],
						operation: ['getPageInsights'],
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;

			try {
				if (operation === 'getSites') {
					const response = await this.helpers.requestWithAuthentication.call(this, 'GoogleSearchConsoleOAuth2Api', {
						method: 'GET',
						url: 'https://www.googleapis.com/webmasters/v3/sites',
					});

					const parsedResponse = typeof response === 'string' ? JSON.parse(response) : response;

					if (Array.isArray(parsedResponse.siteEntry)) {
						for (const entry of parsedResponse.siteEntry) {
							returnData.push({ json: { resource: 'site', operation: 'getSites', ...entry } });
						}
					} else {
						throw new NodeOperationError(this.getNode(), 'Unexpected response format: "siteEntry" not found or not an array.');
					}
				}

				if (operation === 'getPageInsights') {
					const siteUrl = this.getNodeParameter('siteUrl', i) as string;
					const startDate = this.getNodeParameter('startDate', i) as string;
					const endDate = this.getNodeParameter('endDate', i) as string;
					const rowLimit = this.getNodeParameter('rowLimit', i) as number;
					const searchType = this.getNodeParameter('searchType', i) as string;
					const dimensions = this.getNodeParameter('dimensions', i) as string[];

					if (!/^https?:\/\//.test(siteUrl) && !/^sc-domain:/.test(siteUrl)) {
						throw new NodeOperationError(this.getNode(), 'Site URL must start with http://, https:// or sc-domain:', { itemIndex: i });
					}

					const requestBody = {
						startDate: new Date(startDate).toISOString().split('T')[0],
						endDate: new Date(endDate).toISOString().split('T')[0],
						dimensions,
						rowLimit,
						searchType,
					};

					const encodedSiteUrl = encodeURIComponent(siteUrl);
					const response = await this.helpers.requestWithAuthentication.call(this, 'GoogleSearchConsoleOAuth2Api', {
						method: 'POST',
						url: `https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/searchAnalytics/query`,
						body: requestBody,
					});

					const parsedResponse = typeof response === 'string' ? JSON.parse(response) : response;

					if (Array.isArray(parsedResponse.rows)) {
						for (const row of parsedResponse.rows) {
							returnData.push({ json: { resource: 'site', operation: 'getPageInsights', ...row } });
						}
					} else {
						throw new NodeOperationError(this.getNode(), 'Unexpected response format: "rows" not found or not an array.', { itemIndex: i });
					}
				}
			} catch (error) {
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
