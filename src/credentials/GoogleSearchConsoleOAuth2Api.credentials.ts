import type { ICredentialType, INodeProperties } from 'n8n-workflow';

const scopes = [
	'https://www.googleapis.com/auth/webmasters',
	'https://www.googleapis.com/auth/webmasters.readonly',
];

export class GoogleSearchConsoleOAuth2Api implements ICredentialType {
	name = 'googleSearchConsoleOAuth2Api';

	extends = ['googleOAuth2Api'];

	displayName = 'Google Search Console OAuth2 API';

	// تغییر لینک به مستندات رسمی گوگل
	documentationUrl = 'https://developers.google.com/webmaster-tools/search-console-api-original/v3/quickstart';

	properties: INodeProperties[] = [
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: scopes.join(' '),
		},
	];
}