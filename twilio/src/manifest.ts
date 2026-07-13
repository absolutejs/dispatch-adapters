import { defineImplementation, defineManifest } from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import type { CreateTwilioAdapterOptions } from './index';

export const manifest = defineManifest<CreateTwilioAdapterOptions>()({
	contract: 1,
	identity: {
		accent: '#f22f46',
		category: 'messaging',
		description:
			'Twilio-backed `SmsAdapter` for `@absolutejs/dispatch`. Takes your Twilio client; supports single origination numbers and Messaging Service routing.',
		docsUrl:
			'https://github.com/absolutejs/dispatch-adapters/tree/main/twilio',
		name: '@absolutejs/dispatch-twilio',
		tagline: 'Send text messages with Twilio.'
	},
	implements: [
		defineImplementation<CreateTwilioAdapterOptions>()({
			contract: 'dispatch/sms-adapter',
			factory: 'createTwilioAdapter',
			from: '@absolutejs/dispatch-twilio',
			requires: {
				env: [
					{
						description: 'Twilio account SID',
						docsUrl: 'https://console.twilio.com',
						example: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
						key: 'TWILIO_ACCOUNT_SID',
						secret: true
					},
					{
						description: 'Twilio auth token',
						docsUrl: 'https://console.twilio.com',
						key: 'TWILIO_AUTH_TOKEN',
						secret: true
					}
				],
				peers: [
					{
						name: 'twilio',
						range: '^5.0.0',
						reason: 'Twilio SDK client'
					}
				]
			},
			settings: Type.Object({
				defaultFrom: Type.Optional(
					Type.String({
						description:
							'The phone number texts are sent from, in international format. Leave empty when using a Messaging Service.',
						examples: ['+12025550100'],
						title: 'Sending number'
					})
				),
				messagingServiceSid: Type.Optional(
					Type.String({
						description:
							'Use Twilio Messaging Service routing instead of a single number. Set this OR a sending number, not both.',
						example: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
						title: 'Messaging Service SID'
					})
				)
			}),
			title: 'Twilio',
			wiring: {
				code: 'createTwilioAdapter({ client: twilio(${env.TWILIO_ACCOUNT_SID}, ${env.TWILIO_AUTH_TOKEN}), ...${settings} })',
				imports: [
					{
						from: '@absolutejs/dispatch-twilio',
						names: ['createTwilioAdapter']
					},
					{ from: 'twilio', names: ['twilio'] }
				]
			}
		})
	],
	settings: Type.Object({}),
	wiring: []
});
