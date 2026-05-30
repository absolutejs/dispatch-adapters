/**
 * @absolutejs/dispatch-postmark — Postmark-backed `EmailAdapter` for
 * `@absolutejs/dispatch`.
 *
 * Takes the user's Postmark `ServerClient`. Maps `EmailMessage` to
 * Postmark's `sendEmail` params; surfaces `MessageID` as
 * `DispatchResult.id`.
 *
 * Postmark's response shape:
 * ```
 * { To, SubmittedAt, MessageID, ErrorCode, Message }
 * ```
 *
 * `ErrorCode !== 0` indicates a Postmark-side rejection (validation,
 * suppression, etc). The adapter throws so
 * `@absolutejs/dispatch`'s error path runs (`dispatch.email.failed`
 * audit event, span ERROR, failed counter).
 */
import type { EmailAdapter, EmailMessage } from '@absolutejs/dispatch';

/**
 * Minimal subset of Postmark's `ServerClient` we use. Declaring it
 * locally keeps `postmark` a true peer dep — types aren't required at
 * compile time.
 */
export type PostmarkClientLike = {
	sendEmail: (params: {
		From: string;
		To: string;
		Subject: string;
		TextBody?: string;
		HtmlBody?: string;
		ReplyTo?: string;
		Cc?: string;
		Bcc?: string;
		Headers?: Array<{ Name: string; Value: string }>;
		Tag?: string;
		Metadata?: Record<string, string>;
		MessageStream?: string;
	}) => Promise<{
		MessageID?: string;
		SubmittedAt?: string;
		To?: string;
		ErrorCode?: number;
		Message?: string;
	}>;
};

export type CreatePostmarkAdapterOptions = {
	/** The Postmark client (`new ServerClient(serverToken)`). */
	client: PostmarkClientLike;
	/**
	 * Default `From` address. Postmark REQUIRES `From`; if neither the
	 * message nor this default is set, the adapter throws.
	 */
	defaultFrom?: string;
	/**
	 * Postmark message stream. Postmark separates "transactional" and
	 * "broadcast" streams; default is `'outbound'` (transactional).
	 * Override to send to a broadcast stream when appropriate.
	 */
	messageStream?: string;
	/**
	 * Map `EmailMessage.metadata` to Postmark's `Metadata` (a string→
	 * string map). Default: passes through string-valued entries
	 * (Postmark Metadata values must be strings).
	 *
	 * Also extracts a `tag` field from metadata into Postmark's `Tag`
	 * (a single string per message, used for segmenting analytics).
	 */
	mapMetadata?: (metadata: Record<string, unknown>) => {
		Metadata?: Record<string, string>;
		Tag?: string;
	};
};

const arrayOrUndefined = (
	value: string | ReadonlyArray<string> | undefined
): string | undefined => {
	if (value === undefined) return undefined;
	if (typeof value === 'string') return value;
	return value.join(',');
};

const headersToPostmark = (
	headers: Record<string, string> | undefined
): Array<{ Name: string; Value: string }> | undefined => {
	if (headers === undefined) return undefined;
	const entries = Object.entries(headers);
	if (entries.length === 0) return undefined;
	return entries.map(([Name, Value]) => ({ Name, Value }));
};

const defaultMapMetadata = (
	metadata: Record<string, unknown>
): { Metadata?: Record<string, string>; Tag?: string } => {
	const Metadata: Record<string, string> = {};
	let Tag: string | undefined;
	for (const [name, value] of Object.entries(metadata)) {
		if (typeof value !== 'string') continue;
		if (name === 'tag') {
			Tag = value;
		} else {
			Metadata[name] = value;
		}
	}
	return {
		...(Object.keys(Metadata).length > 0 ? { Metadata } : {}),
		...(Tag !== undefined ? { Tag } : {})
	};
};

export const createPostmarkAdapter = (
	options: CreatePostmarkAdapterOptions
): EmailAdapter => {
	const { client } = options;
	const messageStream = options.messageStream;
	const mapMetadata = options.mapMetadata ?? defaultMapMetadata;

	return {
		name: 'postmark',
		send: async (message: EmailMessage) => {
			const From = message.from ?? options.defaultFrom;
			if (From === undefined || From.length === 0) {
				throw new Error(
					'[dispatch-postmark] no `From` address — Postmark requires one. ' +
						'Pass `message.from` per send, or `createPostmarkAdapter({ defaultFrom })`.'
				);
			}
			const To = arrayOrUndefined(message.to) ?? '';
			const meta =
				message.metadata !== undefined
					? mapMetadata(message.metadata)
					: {};
			const response = await client.sendEmail({
				From,
				Subject: message.subject,
				To,
				...(message.text !== undefined
					? { TextBody: message.text }
					: {}),
				...(message.html !== undefined
					? { HtmlBody: message.html }
					: {}),
				...(message.replyTo !== undefined
					? { ReplyTo: message.replyTo }
					: {}),
				...(arrayOrUndefined(message.cc) !== undefined
					? { Cc: arrayOrUndefined(message.cc)! }
					: {}),
				...(arrayOrUndefined(message.bcc) !== undefined
					? { Bcc: arrayOrUndefined(message.bcc)! }
					: {}),
				...(headersToPostmark(message.headers) !== undefined
					? { Headers: headersToPostmark(message.headers)! }
					: {}),
				...(meta.Metadata !== undefined
					? { Metadata: meta.Metadata }
					: {}),
				...(meta.Tag !== undefined ? { Tag: meta.Tag } : {}),
				...(messageStream !== undefined
					? { MessageStream: messageStream }
					: {})
			});
			if (response.ErrorCode !== undefined && response.ErrorCode !== 0) {
				throw new Error(
					`[dispatch-postmark] Postmark ErrorCode ${response.ErrorCode}: ${response.Message ?? '(no message)'}`
				);
			}
			return {
				at: Date.now(),
				...(response.MessageID !== undefined
					? { id: response.MessageID }
					: {}),
				provider: 'postmark'
			};
		}
	};
};
