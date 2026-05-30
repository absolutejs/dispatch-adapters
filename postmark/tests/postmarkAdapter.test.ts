import { describe, expect, test } from 'bun:test';
import { createDispatcher } from '@absolutejs/dispatch';
import {
	createPostmarkAdapter,
	type PostmarkClientLike
} from '../src/index';

const makeMockPostmark = () => {
	const calls: Array<Parameters<PostmarkClientLike['sendEmail']>[0]> = [];
	let nextResponse: Awaited<
		ReturnType<PostmarkClientLike['sendEmail']>
	> = { MessageID: 'pm-msg-1' };
	const client: PostmarkClientLike = {
		sendEmail: async (params) => {
			calls.push(params);
			return nextResponse;
		}
	};
	return {
		calls,
		client,
		setResponse: (
			response: Awaited<ReturnType<PostmarkClientLike['sendEmail']>>
		) => {
			nextResponse = response;
		}
	};
};

describe('createPostmarkAdapter', () => {
	test('maps EmailMessage fields to Postmark params', async () => {
		const mock = makeMockPostmark();
		const adapter = createPostmarkAdapter({ client: mock.client });
		const dispatcher = createDispatcher({ email: adapter });
		await dispatcher.email({
			from: 'sender@acme.io',
			subject: 'Welcome',
			text: 'Hello there',
			to: 'alice@example.com'
		});
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]).toMatchObject({
			From: 'sender@acme.io',
			Subject: 'Welcome',
			TextBody: 'Hello there',
			To: 'alice@example.com'
		});
	});

	test('returns Postmark MessageID as DispatchResult.id', async () => {
		const mock = makeMockPostmark();
		const adapter = createPostmarkAdapter({ client: mock.client });
		const dispatcher = createDispatcher({ email: adapter });
		const result = await dispatcher.email({
			from: 's@acme.io',
			subject: 's',
			text: 't',
			to: 'a@b.c'
		});
		expect(result.provider).toBe('postmark');
		expect(result.id).toBe('pm-msg-1');
	});

	test('defaultFrom fills in when message has no from', async () => {
		const mock = makeMockPostmark();
		const adapter = createPostmarkAdapter({
			client: mock.client,
			defaultFrom: 'no-reply@acme.io'
		});
		const dispatcher = createDispatcher({ email: adapter });
		await dispatcher.email({ subject: 's', text: 't', to: 'a@b.c' });
		expect(mock.calls[0]!.From).toBe('no-reply@acme.io');
	});

	test('throws when no from is available', async () => {
		const mock = makeMockPostmark();
		const adapter = createPostmarkAdapter({ client: mock.client });
		const dispatcher = createDispatcher({
			email: adapter,
			onError: () => {}
		});
		await expect(
			dispatcher.email({ subject: 's', text: 't', to: 'a@b.c' })
		).rejects.toThrow(/no `From` address/);
	});

	test('array to is joined with commas (Postmark accepts CSV)', async () => {
		const mock = makeMockPostmark();
		const adapter = createPostmarkAdapter({ client: mock.client });
		const dispatcher = createDispatcher({ email: adapter });
		await dispatcher.email({
			from: 's@acme.io',
			subject: 's',
			text: 't',
			to: ['a@b.c', 'd@e.f']
		});
		expect(mock.calls[0]!.To).toBe('a@b.c,d@e.f');
	});

	test('cc/bcc/replyTo/headers/htmlBody all pass through', async () => {
		const mock = makeMockPostmark();
		const adapter = createPostmarkAdapter({ client: mock.client });
		const dispatcher = createDispatcher({ email: adapter });
		await dispatcher.email({
			bcc: ['silent@acme.io'],
			cc: ['cc@acme.io'],
			from: 's@acme.io',
			headers: { 'X-Tenant': 'tenant-A' },
			html: '<p>hi</p>',
			replyTo: 'reply@acme.io',
			subject: 's',
			text: 't',
			to: 'a@b.c'
		});
		expect(mock.calls[0]!.HtmlBody).toBe('<p>hi</p>');
		expect(mock.calls[0]!.ReplyTo).toBe('reply@acme.io');
		expect(mock.calls[0]!.Cc).toBe('cc@acme.io');
		expect(mock.calls[0]!.Bcc).toBe('silent@acme.io');
		expect(mock.calls[0]!.Headers).toEqual([
			{ Name: 'X-Tenant', Value: 'tenant-A' }
		]);
	});

	test('metadata.tag becomes Postmark Tag; other string entries become Metadata', async () => {
		const mock = makeMockPostmark();
		const adapter = createPostmarkAdapter({ client: mock.client });
		const dispatcher = createDispatcher({ email: adapter });
		await dispatcher.email({
			from: 's@acme.io',
			metadata: {
				campaign: 'welcome-v2',
				priority: 'high',
				tag: 'onboarding'
			},
			subject: 's',
			text: 't',
			to: 'a@b.c'
		});
		expect(mock.calls[0]!.Tag).toBe('onboarding');
		expect(mock.calls[0]!.Metadata).toEqual({
			campaign: 'welcome-v2',
			priority: 'high'
		});
	});

	test('non-string metadata entries are filtered out', async () => {
		const mock = makeMockPostmark();
		const adapter = createPostmarkAdapter({ client: mock.client });
		const dispatcher = createDispatcher({ email: adapter });
		await dispatcher.email({
			from: 's@acme.io',
			metadata: { count: 5, kept: 'yes' },
			subject: 's',
			text: 't',
			to: 'a@b.c'
		});
		expect(mock.calls[0]!.Metadata).toEqual({ kept: 'yes' });
	});

	test('messageStream option overrides per-call', async () => {
		const mock = makeMockPostmark();
		const adapter = createPostmarkAdapter({
			client: mock.client,
			messageStream: 'broadcast'
		});
		const dispatcher = createDispatcher({ email: adapter });
		await dispatcher.email({
			from: 's@acme.io',
			subject: 's',
			text: 't',
			to: 'a@b.c'
		});
		expect(mock.calls[0]!.MessageStream).toBe('broadcast');
	});

	test('ErrorCode != 0 throws and propagates to dispatcher', async () => {
		const mock = makeMockPostmark();
		mock.setResponse({ ErrorCode: 406, Message: 'Inactive recipient' });
		const adapter = createPostmarkAdapter({ client: mock.client });
		const dispatcher = createDispatcher({
			email: adapter,
			onError: () => {}
		});
		await expect(
			dispatcher.email({
				from: 's@acme.io',
				subject: 's',
				text: 't',
				to: 'a@b.c'
			})
		).rejects.toThrow(/Inactive recipient/);
		expect(dispatcher.metrics().failed).toBe(1);
	});

	test('ErrorCode === 0 is treated as success', async () => {
		const mock = makeMockPostmark();
		mock.setResponse({
			ErrorCode: 0,
			Message: 'OK',
			MessageID: 'pm-ok'
		});
		const adapter = createPostmarkAdapter({ client: mock.client });
		const dispatcher = createDispatcher({ email: adapter });
		const result = await dispatcher.email({
			from: 's@acme.io',
			subject: 's',
			text: 't',
			to: 'a@b.c'
		});
		expect(result.id).toBe('pm-ok');
	});

	test('custom mapMetadata replaces default', async () => {
		const mock = makeMockPostmark();
		const adapter = createPostmarkAdapter({
			client: mock.client,
			mapMetadata: () => ({ Tag: 'always', Metadata: { static: 'yes' } })
		});
		const dispatcher = createDispatcher({ email: adapter });
		await dispatcher.email({
			from: 's@acme.io',
			metadata: { ignored: 'value' },
			subject: 's',
			text: 't',
			to: 'a@b.c'
		});
		expect(mock.calls[0]!.Tag).toBe('always');
		expect(mock.calls[0]!.Metadata).toEqual({ static: 'yes' });
	});
});
