export class BulkUnavailableError extends Error {}
export async function scanBulkSenderDirectory(..._args: unknown[]):Promise<never>{throw new BulkUnavailableError('Sender indexing uses Google’s standard Gmail API. Completed headers are cached in this browser and reused on the next scan.');}
