import process from 'node:process';
import * as http from 'node:http';
import * as https from 'node:https';
import {existsSync, readFileSync, writeFileSync, watchFile, mkdirSync, unwatchFile} from 'node:fs';
import * as path from 'node:path';
import {randomInt} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {
  nip19,
  nip44,
  generateSecretKey,
  getPublicKey,
  Event as NostrEvent,
  UnsignedEvent,
  verifyEvent,
  finalizeEvent,
  getEventHash,
} from 'nostr-tools';
import {SimplePool, useWebSocketImplementation} from 'nostr-tools/pool';
import {WebSocket} from 'ws';
import {Minimatch} from 'minimatch';
import {normalizeURL} from 'nostr-tools/utils';

const EphemeralGiftWrapKind = 21059;
const SealKind = 13;
const HttpRequestKind = 80;
const HttpResponseKind = 81;

// NIP-44 limits the size of the encrypted content to 64k. We want to split the body of the http
// response to chunks small enough so they could be encoded in base64, joined with other
// metadata (response status & headers), and encrypted twice: first for the seal, and then for
// the gift-wrap (the first encyption adds an overhead that should be considered in the second
// encryption).
const partBodyMaxSize = 16384;

type RequestModule = typeof http | typeof https;

function getRequestModule(url: string): RequestModule {
  const urlLowerCase = url.toLowerCase();
  if (urlLowerCase.startsWith('http://')) {
    return http;
  }
  if (urlLowerCase.startsWith('https://')) {
    return https;
  }
  throw new Error('Unexpected url protocol: must begin with http:// or https://');
}

function writeFile(filename: string, payload: string): void {
  const dirname = path.dirname(filename);
  if (!existsSync(dirname)) {
    mkdirSync(dirname, {recursive: true});
  }
  writeFileSync(filename, payload);
}

interface ReadWriteSecretKeyOptions {
  nsecFile: string;
  saveNsec?: boolean;
}

function readWriteSecretKey({nsecFile, saveNsec}: ReadWriteSecretKeyOptions): Uint8Array {
  if (existsSync(nsecFile)) {
    const existingSecretKey = nip19.decode(readFileSync(nsecFile).toString().trim());
    if (existingSecretKey.type !== 'nsec') {
      throw new Error('Unexpected private key format');
    }
    return existingSecretKey.data;
  }
  if (!saveNsec) {
    throw new Error('nsec-file not found');
  }
  const secretKey = generateSecretKey();
  console.info('Saving nsec-file');
  writeFile(nsecFile, nip19.nsecEncode(secretKey));
  return secretKey;
}

interface ReadWriteRelaysOptions {
  relays?: string[];
  relaysFile?: string;
}

function readWriteRelays({relays, relaysFile}: ReadWriteRelaysOptions): string[] {
  if (relaysFile && existsSync(relaysFile)) {
    // Return relays from file even if it is empty.
    return readFileSync(relaysFile).toString().split(/\s+/).filter(Boolean);
  }
  // Support both an array of relays or a single string of relays separated by spaces.
  const relaysSplit = relays?.map(r => r.split(' '));
  const relaysFromOption = relaysSplit ? ([] as string[]).concat(...relaysSplit) : [];
  if (relaysFromOption.length === 0) {
    throw new Error('Missing --relays option, or a --relays-file option that points to a file.');
  }
  if (relaysFile) {
    writeFile(relaysFile, relaysFromOption.join('\n'));
  }
  return relaysFromOption;
}

interface RequestMessage {
  id: string;
  partIndex: number;
  parts: number;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  bodyBase64: string;
}

interface ResponseMessage {
  id: string;
  partIndex: number;
  parts: number;
  status?: number;
  headers?: Record<string, string>;
  bodyBase64: string;
}

interface PendingRequest {
  requestMessages: Map<number, RequestMessage>;
  timeout: NodeJS.Timeout;
}

interface RequestInfo {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBuffer: Buffer;
}

interface ResponseInfo {
  status: number;
  headers: Record<string, string>;
  bodyBuffer: Buffer;
}

interface ResponseManipulatorOptions {
  request: RequestInfo;
  response: ResponseInfo;
  secretKey: Uint8Array;
  destination: string;
  nprofile: string;
}

interface ResponseManipulatorModule {
  default: (options: ResponseManipulatorOptions) => ResponseInfo;
}

interface GetResponseOptions {
  logPrefix: string;
  requestModule: RequestModule;
  destination: string;
  positiveMinimatchers?: Minimatch[];
  negativeMinimatchers: Minimatch[];
  timeout: number;
  responseManipulatorModule?: ResponseManipulatorModule;
  secretKey: Uint8Array;
  nprofile: string;
}

async function getResponse(
  requestInfo: RequestInfo,
  {
    logPrefix,
    requestModule,
    destination,
    positiveMinimatchers,
    negativeMinimatchers,
    timeout,
    responseManipulatorModule,
    secretKey,
    nprofile,
  }: GetResponseOptions
): Promise<ResponseInfo> {
  try {
    const isRouteAllowed =
      requestInfo.url[0] === '/' &&
      (positiveMinimatchers === undefined || positiveMinimatchers.some(m => m.match(requestInfo.url))) &&
      !negativeMinimatchers.some(m => m.match(requestInfo.url));
    if (!isRouteAllowed) {
      console.warn(`${logPrefix}: Forbidden route`);
      return {
        status: 403,
        headers: {},
        bodyBuffer: Buffer.from('Forbidden route'),
      };
    }
    const responseInfo = await new Promise<ResponseInfo>((resolve, reject) => {
      const httpRequest = requestModule.request(
        destination + requestInfo.url,
        {
          timeout,
          method: requestInfo.method,
          headers: requestInfo.headers,
        },
        res => {
          const responseChunks: Buffer[] = [];
          res.on('data', chunk => {
            responseChunks.push(chunk);
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 500,
              headers: Object.fromEntries(
                Object.entries(res.headers).map(([headerName, headerValue]) => [
                  headerName,
                  Array.isArray(headerValue) ? headerValue[0] : headerValue ?? '',
                ])
              ),
              bodyBuffer: Buffer.concat(responseChunks),
            })
          );
        }
      );
      httpRequest.on('error', err => reject(err));
      httpRequest.end(requestInfo.bodyBuffer);
    });
    if (!responseManipulatorModule) {
      return responseInfo;
    }
    const newResponseMessage = await responseManipulatorModule.default({
      request: requestInfo,
      response: responseInfo,
      secretKey,
      destination,
      nprofile,
    });
    if (newResponseMessage === undefined) {
      return responseInfo;
    }
    if (!newResponseMessage || typeof newResponseMessage !== 'object') {
      throw new Error('Response manipulator did not return an object.');
    }
    if (Object.keys(newResponseMessage).length > 3) {
      throw new Error('Response manipulator returned too many fields.');
    }
    if (typeof newResponseMessage.status !== 'number') {
      throw new Error('Response manipulator must return an object with a status field of type number.');
    }
    if (
      !newResponseMessage.headers ||
      typeof newResponseMessage.headers !== 'object' ||
      Object.values(newResponseMessage.headers).some(h => typeof h !== 'string')
    ) {
      throw new Error('Response manipulator returned an unexpected headers field.');
    }
    if (!Buffer.isBuffer(newResponseMessage.bodyBuffer)) {
      throw new Error('Response manipulator must return an object with a bodyBuffer field of type Buffer.');
    }
    return newResponseMessage;
  } catch (err) {
    console.error(`${logPrefix}: Request failed:`, err);
    return {
      status: 500,
      headers: {},
      bodyBuffer: Buffer.from('Request failed'),
    };
  }
}

interface RelayStatus {
  relay: string;
  isConnected: boolean;
}

async function getRelaysStatuses(pool: SimplePool, relayUrls: string[]): Promise<RelayStatus[]> {
  const allRelays = await Promise.all(relayUrls.map(relayUrl => pool.ensureRelay(relayUrl)));
  return allRelays.map(relay => ({
    relay: relay.url,
    isConnected: relay.connected,
  }));
}

export interface RunServerOptions extends ReadWriteSecretKeyOptions, ReadWriteRelaysOptions {
  verbose?: boolean;
  saveNpubFile?: string;
  allowedRoutes?: string[];
  responseManipulatorFile?: string;
  nprofileMaxRelays: string;
  timeout: string;
  saveNprofileFile?: string;
  exitOnFileChange?: boolean;
}

export async function runServer(destination: string, options: RunServerOptions): Promise<() => void> {
  const verboseLog = options.verbose ? (t: string) => console.info(t) : () => {};
  verboseLog('Installing WebSockets');
  useWebSocketImplementation(WebSocket);

  const secretKey = readWriteSecretKey(options);
  const publicKey = getPublicKey(secretKey);
  verboseLog(`Public key: ${publicKey}`);
  if (options.saveNpubFile) {
    console.info('Saving npub-file');
    writeFile(options.saveNpubFile, nip19.npubEncode(publicKey));
  }

  const positiveMinimatchers = options.allowedRoutes
    ? options.allowedRoutes.filter(r => r[0] !== '!').map(r => new Minimatch(r, {dot: true, platform: 'darwin'}))
    : undefined;
  const negativeMinimatchers = options.allowedRoutes
    ? options.allowedRoutes
        .filter(r => r[0] === '!')
        .map(r => new Minimatch(r.slice(1), {dot: true, platform: 'darwin'}))
    : [];

  const responseManipulatorModule: ResponseManipulatorModule | undefined =
    options.responseManipulatorFile && (await import(options.responseManipulatorFile));

  // Support both an array of relays or a single string of relays separated by spaces.
  const initialRelayUrls = readWriteRelays(options).map(normalizeURL);
  if (initialRelayUrls.length === 0) {
    throw new Error('No relays to connect');
  }
  let oldestTime = Date.now() / 1000;
  const handledRequestIds = new Map<string, number>();
  const intervals = [
    setInterval(() => {
      oldestTime = Date.now() / 1000 - 60; // up to 1 minute delay
      for (const [requestId, requestTime] of [...handledRequestIds.entries()]) {
        if (requestTime < oldestTime) {
          handledRequestIds.delete(requestId);
        }
      }
    }, 600_000),
  ];
  let pool: SimplePool | undefined = new SimplePool();
  const handledEventTimes = new Map<string, number>();
  const pendingRequests = new Map<string, PendingRequest>();
  const subscribe = (since: number) =>
    pool?.subscribeMany(
      initialRelayUrls,
      [
        {
          since,
          kinds: [EphemeralGiftWrapKind],
          '#p': [publicKey],
        },
      ],
      {
        alreadyHaveEvent: eventId => handledEventTimes.has(eventId),
        onevent: async (requestEvent: NostrEvent): Promise<void> => {
          handledEventTimes.set(requestEvent.id, requestEvent.created_at);
          try {
            verboseLog(
              `${requestEvent.id}: Received event: ${JSON.stringify({...requestEvent, content: '...'})}, content-size: ${requestEvent.content.length}`
            );
            if (requestEvent.kind !== EphemeralGiftWrapKind) {
              return;
            }
            let requestMessage: RequestMessage;
            let requestSeal: NostrEvent;
            try {
              const decryptedSeal = nip44.decrypt(
                requestEvent.content,
                nip44.getConversationKey(secretKey, requestEvent.pubkey)
              );
              verboseLog(`${requestEvent.id}: Decrypted seal`);
              requestSeal = JSON.parse(decryptedSeal);
              verboseLog(`${requestEvent.id}: Parsed seal id: ${requestSeal.id}, kind: ${requestSeal.kind}`);
              if (requestSeal.kind !== SealKind) {
                return;
              }
              if (!verifyEvent(requestSeal)) {
                verboseLog(`${requestEvent.id}: Unverified event`);
                return;
              }
              const decryptedContent = nip44.decrypt(
                requestSeal.content,
                nip44.getConversationKey(secretKey, requestSeal.pubkey)
              );
              verboseLog(`${requestEvent.id}: Decrypted content.`);
              const unsignedRequest: Omit<NostrEvent, 'sig'> = JSON.parse(decryptedContent);
              if (unsignedRequest.kind !== HttpRequestKind) {
                return;
              }
              if (unsignedRequest.pubkey !== requestSeal.pubkey) {
                verboseLog(`${requestEvent.id}: Invalid pubkey`);
                return;
              }
              if (
                typeof unsignedRequest.created_at !== 'number' ||
                typeof unsignedRequest.id !== 'string' ||
                typeof unsignedRequest.content !== 'string'
              ) {
                verboseLog(`${requestEvent.id}: Bad format`);
                return;
              }
              if (unsignedRequest.created_at < oldestTime) {
                verboseLog(`${requestEvent.id}: Old event`);
                return;
              }
              if (Date.now() / 1000 + 600 < unsignedRequest.created_at) {
                verboseLog(`${requestEvent.id}: Future event`);
                return;
              }
              if (handledRequestIds.has(unsignedRequest.id)) {
                verboseLog(`${requestEvent.id}: Handled event`);
                return;
              }
              handledRequestIds.set(unsignedRequest.id, unsignedRequest.created_at);
              requestMessage = JSON.parse(unsignedRequest.content);
              if (!requestMessage || typeof requestMessage !== 'object') {
                throw new Error('Unexpected content type');
              }
              const {id, partIndex, parts, headers, method, url, bodyBase64} = requestMessage;
              if (!id || typeof id !== 'string' || id.length > 100) {
                throw new Error('Unexpected type for field: id');
              }
              if (!Number.isSafeInteger(partIndex) || partIndex < 0) {
                throw new Error('Unexpected type for field: partIndex');
              }
              if (!Number.isSafeInteger(parts) || parts < 1) {
                throw new Error('Unexpected type for field: partIndex');
              }
              if (typeof bodyBase64 !== 'string') {
                throw new Error('Unexpected type for field: bodyBase64');
              }
              if (partIndex === 0) {
                if (!url || typeof url !== 'string') {
                  throw new Error('Unexpected type for field: url');
                }
                if (!method || typeof method !== 'string') {
                  throw new Error('Unexpected type for field: method');
                }
                if (
                  !headers ||
                  typeof headers !== 'object' ||
                  Object.values(headers).some(v => typeof v !== 'string')
                ) {
                  throw new Error('Unexpected type for field: headers');
                }
              }
            } catch (err) {
              console.error(`${requestEvent.id}: Failed to handle event`, err);
              return;
            }
            const logPrefix = `${requestEvent.id}:${JSON.stringify(requestMessage.id)}:${requestMessage.partIndex}/${requestMessage.parts}`;
            verboseLog(`${logPrefix}: received part.`);
            if (!pendingRequests.has(requestMessage.id)) {
              pendingRequests.set(requestMessage.id, {
                requestMessages: new Map(),
                timeout: setTimeout(() => {
                  pendingRequests.delete(requestMessage.id);
                }, 60_000).unref(),
              });
            }
            const pendingRequest = pendingRequests.get(requestMessage.id)!;
            pendingRequest.requestMessages.set(requestMessage.partIndex, requestMessage);
            if (pendingRequest.requestMessages.size < requestMessage.parts) {
              return;
            }
            clearTimeout(pendingRequest.timeout);
            pendingRequests.delete(requestMessage.id);
            const firstRequestMessage = pendingRequest.requestMessages.get(0);
            if (!firstRequestMessage) {
              throw new Error(`Malformed request sequence`);
            }
            console.info(
              `${logPrefix}: ${nip19.npubEncode(
                requestSeal.pubkey
              )} ${JSON.stringify(firstRequestMessage.method)} ${JSON.stringify(firstRequestMessage.url)}`
            );
            const responseInfo = await getResponse(
              {
                url: firstRequestMessage.url!,
                method: firstRequestMessage.method!,
                headers: firstRequestMessage.headers!,
                bodyBuffer: Buffer.concat(
                  Array.from({length: pendingRequest.requestMessages.size}).map((_, index) =>
                    Buffer.from(pendingRequest.requestMessages.get(index)?.bodyBase64 ?? '', 'base64')
                  )
                ),
              },
              {
                logPrefix,
                requestModule,
                destination,
                positiveMinimatchers,
                negativeMinimatchers,
                timeout: Number(options.timeout),
                responseManipulatorModule,
                secretKey,
                nprofile,
              }
            );
            const {bodyBuffer, ...other} = responseInfo;
            verboseLog(`${logPrefix}: Response ${JSON.stringify(other)}, body-size: ${bodyBuffer.length}`);
            const bodyBase64Chunks: [string, number][] = [];
            if (bodyBuffer.length === 0) {
              bodyBase64Chunks.push(['', 0]);
            } else {
              for (let partIndex = 0; partIndex * partBodyMaxSize < bodyBuffer.length; partIndex += 1) {
                bodyBase64Chunks.push([
                  bodyBuffer
                    .subarray(partIndex * partBodyMaxSize, (partIndex + 1) * partBodyMaxSize)
                    .toString('base64'),
                  partIndex,
                ]);
              }
            }
            for (const [bodyBase64Chunk, partIndex] of bodyBase64Chunks) {
              const responseMessage: ResponseMessage = {
                id: requestMessage.id,
                partIndex: partIndex,
                parts: bodyBase64Chunks.length,
                ...(partIndex === 0 && {
                  status: responseInfo.status,
                  headers: Object.fromEntries(
                    Object.entries(responseInfo.headers).map(([headerName, headerValue]) => [
                      headerName,
                      Array.isArray(headerValue) ? headerValue[0] : headerValue ?? '',
                    ])
                  ),
                }),
                bodyBase64: bodyBase64Chunk,
              };
              verboseLog(`${logPrefix}: Sending response part ${partIndex}/${bodyBase64Chunks.length}`);
              const now = Math.floor(Date.now() / 1000);
              const unsignedResponse: UnsignedEvent = {
                kind: HttpResponseKind,
                tags: [],
                content: JSON.stringify(responseMessage),
                created_at: now,
                pubkey: publicKey,
              };
              const unsignedResponseId = getEventHash(unsignedResponse);
              const finalUnsignedResponse = {
                ...unsignedResponse,
                id: unsignedResponseId,
              };
              const finalUnsignedResponseStringified = JSON.stringify(finalUnsignedResponse);
              verboseLog(
                `${logPrefix}: unsigned response: ${JSON.stringify({
                  ...finalUnsignedResponse,
                  content: '...',
                })}, content-size: ${finalUnsignedResponse.content.length}, total-size: ${finalUnsignedResponseStringified.length}`
              );
              const responseSealContent = nip44.encrypt(
                finalUnsignedResponseStringified,
                nip44.getConversationKey(secretKey, requestSeal.pubkey)
              );
              const responseSeal = finalizeEvent(
                {
                  created_at: now - randomInt(0, 48 * 3600),
                  kind: SealKind,
                  tags: [],
                  content: responseSealContent,
                },
                secretKey
              );
              const responseSealStringified = JSON.stringify(responseSeal);
              verboseLog(
                `${logPrefix}: response seal: ${JSON.stringify({
                  ...responseSeal,
                  content: '...',
                })}, content-size: ${responseSealContent.length} total-size: ${responseSealStringified.length}`
              );
              const randomPrivateKey = generateSecretKey();
              verboseLog(`${logPrefix}: random public key: ${getPublicKey(randomPrivateKey)}`);
              const safeRelays = initialRelayUrls.filter(relay => {
                const parsedRelay = new URL(relay);
                // Don't publish relay addresses that might contain sensitive information
                return !parsedRelay.username && !parsedRelay.password && !parsedRelay.search;
              });
              const responseEvent = finalizeEvent(
                {
                  created_at: now,
                  kind: EphemeralGiftWrapKind,
                  tags: [
                    ['p', requestSeal.pubkey, safeRelays[0]],
                    ...(safeRelays.length > 1 ? [['relays', ...safeRelays.slice(1)]] : []),
                  ],
                  content: nip44.encrypt(
                    responseSealStringified,
                    nip44.getConversationKey(randomPrivateKey, requestSeal.pubkey)
                  ),
                },
                randomPrivateKey
              );
              verboseLog(
                `${logPrefix}: publishing response event: ${JSON.stringify({
                  ...responseEvent,
                  content: '...',
                })}, content-size ${responseEvent.content.length}`
              );
              // Ugly code, but its the only way I found to log which relay caused the problem.
              await Promise.all(
                initialRelayUrls.map(async initialRelayUrl => {
                  if (!pool) {
                    return;
                  }
                  try {
                    await Promise.all(pool.publish([initialRelayUrl], responseEvent));
                  } catch (error) {
                    console.error(`${logPrefix}: Failed to send reply on ${initialRelayUrl}`, error);
                  }
                })
              );
            }
            console.info(`${logPrefix}: done`);
          } catch (error) {
            console.error(`Failed to handle event ${requestEvent.id}`, error);
          }
        },
      }
    );
  verboseLog('Connecting to relays');
  let subscription = subscribe(Math.ceil(Date.now() / 1000) - 48 * 3600);
  intervals.push(
    setInterval(() => {
      const since = Math.ceil(Date.now() / 1000) - 48 * 3600;
      const newSubsription = subscribe(since);
      subscription?.close();
      subscription = newSubsription;
      for (const [eventId, eventTime] of [...handledEventTimes.entries()]) {
        if (eventTime < since) {
          handledEventTimes.delete(eventId);
        }
      }
    }, 3_600_000)
  );
  await sleep(1000);
  let relaysStatuses = await getRelaysStatuses(pool, initialRelayUrls);
  if (relaysStatuses.every(status => !status.isConnected)) {
    // wait some more
    await sleep(5000);
    relaysStatuses = await getRelaysStatuses(pool, initialRelayUrls);
    if (relaysStatuses.every(status => !status.isConnected)) {
      console.error('Failed to connect to any of the relays.');
      throw new Error('Failed to connect to any of the relays.');
    }
  }
  if (options.verbose) {
    console.table(relaysStatuses);
  } else {
    console.info(`Connected to ${relaysStatuses.filter(w => w.isConnected).length}/${relaysStatuses.length} relays.`);
  }

  const requestModule = getRequestModule(destination);
  const goodRelays = relaysStatuses
    .filter(w => w.isConnected)
    .map(w => w.relay)
    .slice(0, Number(options.nprofileMaxRelays));
  const nprofile = nip19.nprofileEncode({
    pubkey: publicKey,
    relays: goodRelays,
  });

  console.info(
    `This entity includes both your public-key and hints for ${goodRelays.length} of the relays that your are connected to: ${nprofile}`
  );
  if (options.saveNprofileFile) {
    console.info('Saving nprofile-file');
    writeFile(options.saveNprofileFile, nprofile);
  }
  const exit = () => {
    setTimeout(() => {
      console.error('Failed to close connections after 10 seconds');
      process.exit(-1);
    }, 10_000).unref();
    if (pool) {
      pool.close(initialRelayUrls);
      pool = undefined;
    }
    for (const filename of [options.nsecFile, options.relaysFile, options.responseManipulatorFile]) {
      if (filename) {
        unwatchFile(filename);
      }
    }
    for (const interval of intervals) {
      clearInterval(interval);
    }
  };
  if (options.exitOnFileChange) {
    if (options.nsecFile) {
      watchFile(options.nsecFile, () => {
        console.info('Exiting due to nsec-file change:', options.nsecFile);
        exit();
      });
    }
    if (options.relaysFile) {
      watchFile(options.relaysFile, () => {
        console.info('Exiting due to relays-file change:', options.relaysFile);
        exit();
      });
    }
    if (options.responseManipulatorFile) {
      watchFile(options.responseManipulatorFile, () => {
        console.info('Exiting due to response-manipulator-file change:', options.responseManipulatorFile);
        exit();
      });
    }
  }
  return exit;
}
