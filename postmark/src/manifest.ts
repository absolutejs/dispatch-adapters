import { defineImplementation, defineManifest } from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import type { CreatePostmarkAdapterOptions } from './index';

export const manifest = defineManifest<CreatePostmarkAdapterOptions>()({
	contract: 1,
	identity: {
		accent: '#ffde00',
		category: 'messaging',
		description:
			'Postmark-backed `EmailAdapter` for `@absolutejs/dispatch`. Takes your Postmark ServerClient; supports transactional and broadcast message streams.',
		docsUrl:
			'https://github.com/absolutejs/dispatch-adapters/tree/main/postmark',
		name: '@absolutejs/dispatch-postmark',
		tagline: 'Deliver your site’s email with Postmark.'
	},
	implements: [
		defineImplementation<CreatePostmarkAdapterOptions>()({
			contract: 'dispatch/email-adapter',
			factory: 'createPostmarkAdapter',
			from: '@absolutejs/dispatch-postmark',
			requires: {
				env: [
					{
						description: 'Postmark server token',
						docsUrl: 'https://account.postmarkapp.com/servers',
						key: 'POSTMARK_SERVER_TOKEN',
						secret: true
					}
				],
				peers: [
					{
						name: 'postmark',
						range: '^4.0.0',
						reason: 'Postmark SDK client'
					}
				]
			},
			settings: Type.Object({
				defaultFrom: Type.Optional(
					Type.String({
						description:
							'Used when a message doesn’t name a sender. Postmark requires a verified sender signature.',
						examples: ['hello@yoursite.com'],
						format: 'email',
						title: 'Default sender'
					})
				),
				messageStream: Type.Optional(
					Type.String({
						default: 'outbound',
						description:
							"Postmark separates transactional ('outbound') and broadcast streams.",
						title: 'Message stream'
					})
				)
			}),
			title: 'Postmark',
			wiring: {
				code: 'createPostmarkAdapter({ client: new ServerClient(${env.POSTMARK_SERVER_TOKEN} ?? ""), ...${settings} })',
				imports: [
					{
						from: '@absolutejs/dispatch-postmark',
						names: ['createPostmarkAdapter']
					},
					{ from: 'postmark', names: ['ServerClient'] }
				]
			}
		})
	],
	settings: Type.Object({}),
	wiring: []
});

export default manifest;
