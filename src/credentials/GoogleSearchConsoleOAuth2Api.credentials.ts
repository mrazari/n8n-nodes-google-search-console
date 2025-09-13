import type { ICredentialType, INodeProperties } from 'n8n-workflow';

const scopes = [
	'https://www.googleapis.com/auth/webmasters',
	'https://www.googleapis.com/auth/webmasters.readonly',
];

export class GoogleSearchConsoleOAuth2Api implements ICredentialType {
	name = 'GoogleSearchConsoleOAuth2Api';

	extends = ['googleOAuth2Api']; // ارث‌بری از credential داخلی گوگل

	displayName = 'Google Search Console OAuth2 API';

	documentationUrl = 'google/oauth-single-service'; // لینک داکیومنت داخل n8n

	properties: INodeProperties[] = [
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: scopes.join(' '),
		},
	];
}