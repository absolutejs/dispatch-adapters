import { defineImplementation, defineManifest } from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import type { CreateResendAdapterOptions } from './index';

export const manifest = defineManifest<CreateResendAdapterOptions>()({
	contract: 1,
	identity: {
		accent: '#111827',
		category: 'messaging',
		description:
			'Resend-backed `EmailAdapter` for `@absolutejs/dispatch`. Takes your Resend client; emits standard DispatchResult with the Resend message id.',
		docsUrl: 'https://github.com/absolutejs/dispatch-adapters/tree/main/resend',
		name: '@absolutejs/dispatch-resend',
		tagline: 'Deliver your site’s email with Resend.'
	},
	implements: [
		defineImplementation<CreateResendAdapterOptions>()({
			contract: 'dispatch/email-adapter',
			factory: 'createResendAdapter',
			from: '@absolutejs/dispatch-resend',
			requires: {
				env: [
					{
						description: 'Resend API key',
						docsUrl: 'https://resend.com/api-keys',
						example: 're_xxxxxxxxx',
						key: 'RESEND_KEY',
						secret: true
					}
				],
				peers: [
					{
						name: 'resend',
						range: '^4.0.0',
						reason: 'Resend SDK client'
					}
				]
			},
			settings: Type.Object({
				defaultFrom: Type.Optional(
					Type.String({
						description:
							'Used when a message doesn’t name a sender. Resend requires a verified sender.',
						examples: ['hello@yoursite.com'],
						format: 'email',
						title: 'Default sender'
					})
				)
			}),
			title: 'Resend',
			wiring: {
				code: 'createResendAdapter({ client: new Resend(${env.RESEND_KEY}), ...${settings} })',
				imports: [
					{
						from: '@absolutejs/dispatch-resend',
						names: ['createResendAdapter']
					},
					{ from: 'resend', names: ['Resend'] }
				]
			}
		})
	],
	settings: Type.Object({}),
	wiring: []
});
