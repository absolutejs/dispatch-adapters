import { describe, expect, test } from 'bun:test';
import { createDispatcher } from '@absolutejs/dispatch';
import {
	createTwilioAdapter,
	type TwilioClientLike
} from '../src/index';

const makeMockTwilio = () => {
	const calls: Array<
		Parameters<TwilioClientLike['messages']['create']>[0]
	> = [];
	let nextSid = 1;
	let nextResponse:
		| Awaited<ReturnType<TwilioClientLike['messages']['create']>>
		| undefined;
	let nextThrow: Error | undefined;
	const client: TwilioClientLike = {
		messages: {
			create: async (params) => {
				calls.push(params);
				if (nextThrow) {
					const err = nextThrow;
					nextThrow = undefined;
					throw err;
				}
				return (
					nextResponse ?? {
						sid: `SM${String(nextSid++).padStart(32, '0')}`,
						status: 'queued'
					}
				);
			}
		}
	};
	return {
		calls,
		client,
		setResponse: (
			response: Awaited<
				ReturnType<TwilioClientLike['messages']['create']>
			>
		) => {
			nextResponse = response;
		},
		setThrow: (err: Error) => {
			nextThrow = err;
		}
	};
};

describe('createTwilioAdapter', () => {
	test('maps SmsMessage fields to Twilio params', async () => {
		const mock = makeMockTwilio();
		const adapter = createTwilioAdapter({
			client: mock.client,
			defaultFrom: '+15551234567'
		});
		const dispatcher = createDispatcher({ sms: adapter });
		await dispatcher.sms({
			body: 'Your code: 482910',
			to: '+12025550100'
		});
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]).toMatchObject({
			body: 'Your code: 482910',
			from: '+15551234567',
			to: '+12025550100'
		});
	});

	test('returns Twilio sid as DispatchResult.id', async () => {
		const mock = makeMockTwilio();
		const adapter = createTwilioAdapter({
			client: mock.client,
			defaultFrom: '+15551234567'
		});
		const dispatcher = createDispatcher({ sms: adapter });
		const result = await dispatcher.sms({ body: 'hi', to: '+15551' });
		expect(result.provider).toBe('twilio');
		expect(result.id).toMatch(/^SM/);
	});

	test('per-message from overrides defaultFrom', async () => {
		const mock = makeMockTwilio();
		const adapter = createTwilioAdapter({
			client: mock.client,
			defaultFrom: '+15551111111'
		});
		const dispatcher = createDispatcher({ sms: adapter });
		await dispatcher.sms({
			body: 'hi',
			from: '+15552222222',
			to: '+15553333333'
		});
		expect(mock.calls[0]!.from).toBe('+15552222222');
	});

	test('messagingServiceSid is used when no from is available', async () => {
		const mock = makeMockTwilio();
		const adapter = createTwilioAdapter({
			client: mock.client,
			messagingServiceSid: 'MG_test_service'
		});
		const dispatcher = createDispatcher({ sms: adapter });
		await dispatcher.sms({ body: 'hi', to: '+1555' });
		expect(mock.calls[0]!.messagingServiceSid).toBe('MG_test_service');
		expect(mock.calls[0]!.from).toBeUndefined();
	});

	test('per-message from beats messagingServiceSid', async () => {
		const mock = makeMockTwilio();
		const adapter = createTwilioAdapter({
			client: mock.client,
			messagingServiceSid: 'MG_test_service'
		});
		const dispatcher = createDispatcher({ sms: adapter });
		await dispatcher.sms({
			body: 'hi',
			from: '+15551112222',
			to: '+15553334444'
		});
		expect(mock.calls[0]!.from).toBe('+15551112222');
		expect(mock.calls[0]!.messagingServiceSid).toBeUndefined();
	});

	test('throws when no sender (no from, no defaultFrom, no service)', async () => {
		const mock = makeMockTwilio();
		const adapter = createTwilioAdapter({ client: mock.client });
		const dispatcher = createDispatcher({
			onError: () => {},
			sms: adapter
		});
		await expect(
			dispatcher.sms({ body: 'hi', to: '+1555' })
		).rejects.toThrow(/no sender configured/);
	});

	test('statusCallback passes through when set', async () => {
		const mock = makeMockTwilio();
		const adapter = createTwilioAdapter({
			client: mock.client,
			defaultFrom: '+1555',
			statusCallback: 'https://hooks.acme.io/twilio'
		});
		const dispatcher = createDispatcher({ sms: adapter });
		await dispatcher.sms({ body: 'hi', to: '+1556' });
		expect(mock.calls[0]!.statusCallback).toBe(
			'https://hooks.acme.io/twilio'
		);
	});

	test('Twilio SDK throw propagates to dispatcher', async () => {
		const mock = makeMockTwilio();
		mock.setThrow(new Error('Rate limit exceeded'));
		const adapter = createTwilioAdapter({
			client: mock.client,
			defaultFrom: '+1555'
		});
		const dispatcher = createDispatcher({
			onError: () => {},
			sms: adapter
		});
		await expect(
			dispatcher.sms({ body: 'hi', to: '+1556' })
		).rejects.toThrow('Rate limit exceeded');
		expect(dispatcher.metrics().failed).toBe(1);
	});

	test('errorCode in response throws (bulk-send case)', async () => {
		const mock = makeMockTwilio();
		mock.setResponse({
			errorCode: 21610,
			errorMessage: 'Recipient unsubscribed'
		});
		const adapter = createTwilioAdapter({
			client: mock.client,
			defaultFrom: '+1555'
		});
		const dispatcher = createDispatcher({
			onError: () => {},
			sms: adapter
		});
		await expect(
			dispatcher.sms({ body: 'hi', to: '+1556' })
		).rejects.toThrow(/21610/);
	});

	test('errorCode null is treated as success', async () => {
		const mock = makeMockTwilio();
		mock.setResponse({
			errorCode: null,
			errorMessage: null,
			sid: 'SM_ok',
			status: 'queued'
		});
		const adapter = createTwilioAdapter({
			client: mock.client,
			defaultFrom: '+1555'
		});
		const dispatcher = createDispatcher({ sms: adapter });
		const result = await dispatcher.sms({ body: 'hi', to: '+1556' });
		expect(result.id).toBe('SM_ok');
	});

	test('handles missing sid gracefully', async () => {
		const mock = makeMockTwilio();
		mock.setResponse({ status: 'queued' });
		const adapter = createTwilioAdapter({
			client: mock.client,
			defaultFrom: '+1555'
		});
		const dispatcher = createDispatcher({ sms: adapter });
		const result = await dispatcher.sms({ body: 'hi', to: '+1556' });
		expect(result.id).toBeUndefined();
		expect(result.provider).toBe('twilio');
	});
});
