/**
 * @absolutejs/dispatch-twilio — Twilio-backed `SmsAdapter` for
 * `@absolutejs/dispatch`.
 *
 * Takes the user's Twilio client. Maps `SmsMessage` to Twilio's
 * `messages.create` params; surfaces the Message SID as
 * `DispatchResult.id`.
 *
 * Twilio's `messages.create` throws on API errors (rate limiting,
 * invalid number, account suspended, etc), so the adapter's error
 * path is "let Twilio's rejection propagate." `@absolutejs/dispatch`
 * captures it on the `dispatch.sms.send` span, bumps the failed
 * counter, and emits `dispatch.sms.failed`.
 *
 * **Two ways to identify the sender.** Twilio supports either a phone
 * number (`from`) OR a Messaging Service SID (`messagingServiceSid`).
 * Pass `messagingServiceSid` in adapter options to use service-based
 * sending (per-region routing, sender pool, content opt-out
 * management); leave it unset to require `from` per message or
 * `defaultFrom`.
 */
import type { SmsAdapter, SmsMessage } from '@absolutejs/dispatch';

/**
 * Minimal subset of Twilio's client we use. `client.messages.create`
 * is the canonical send entry. Twilio's typed SDK is large; we don't
 * pull its types in — `TwilioClientLike` describes only the shape
 * we touch.
 */
export type TwilioClientLike = {
	messages: {
		create: (params: {
			to: string;
			body: string;
			from?: string;
			messagingServiceSid?: string;
			statusCallback?: string;
		}) => Promise<{
			sid?: string;
			status?: string;
			errorCode?: number | null;
			errorMessage?: string | null;
		}>;
	};
};

export type CreateTwilioAdapterOptions = {
	/** The Twilio client (`twilio(accountSid, authToken)`). */
	client: TwilioClientLike;
	/**
	 * Default origination number (E.164). Required if your messages
	 * don't supply `from` AND you're not using a Messaging Service.
	 */
	defaultFrom?: string;
	/**
	 * Twilio Messaging Service SID. When set, the adapter uses
	 * service-based routing instead of a single origination number.
	 * Pass this OR `defaultFrom`, not both — per-message `from`
	 * overrides this on a per-call basis.
	 */
	messagingServiceSid?: string;
	/**
	 * Twilio status callback URL — invoked when message status
	 * changes (queued → sent → delivered/failed). Wire this to your
	 * own webhook to record delivery in audit.
	 */
	statusCallback?: string;
};

export const createTwilioAdapter = (
	options: CreateTwilioAdapterOptions
): SmsAdapter => {
	const { client } = options;

	return {
		name: 'twilio',
		send: async (message: SmsMessage) => {
			const from = message.from ?? options.defaultFrom;
			if (
				from === undefined &&
				options.messagingServiceSid === undefined
			) {
				throw new Error(
					'[dispatch-twilio] no sender configured. ' +
						'Pass `message.from`, `createTwilioAdapter({ defaultFrom })`, or ' +
						'`createTwilioAdapter({ messagingServiceSid })`.'
				);
			}
			const params: Parameters<TwilioClientLike['messages']['create']>[0] = {
				body: message.body,
				to: message.to
			};
			if (from !== undefined) params.from = from;
			else if (options.messagingServiceSid !== undefined) {
				params.messagingServiceSid = options.messagingServiceSid;
			}
			if (options.statusCallback !== undefined) {
				params.statusCallback = options.statusCallback;
			}
			const response = await client.messages.create(params);
			// Twilio's SDK rejects on API errors via thrown errors, so a
			// returned response with `errorCode != null` is the
			// unusual-but-documented case (some bulk-send flows).
			if (
				response.errorCode !== null &&
				response.errorCode !== undefined
			) {
				throw new Error(
					`[dispatch-twilio] Twilio errorCode ${response.errorCode}: ${response.errorMessage ?? '(no message)'}`
				);
			}
			return {
				at: Date.now(),
				...(response.sid !== undefined ? { id: response.sid } : {}),
				provider: 'twilio'
			};
		}
	};
};
