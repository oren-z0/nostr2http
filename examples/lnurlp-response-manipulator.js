module.exports = ({ responseMessage, keys, destination }) => {
  if (responseMessage.headers['content-type'] !== 'application/json') {
    return;
  }
  let responseBody;
  try {
    responseBody = JSON.parse(responseMessage.bodyBuffer);
  } catch (err) {
    console.error("Failed to parse json body", err);
    return responseMessage;
  }
  if (
    !responseBody ||
    responseBody.tag !== 'payRequest' ||
    typeof responseBody.callback !== 'string' ||
    !responseBody.callback.startsWith(destination + '/')
  ) {
    return;
  }
  return {
    ...responseMessage,
    bodyBuffer: Buffer.from(JSON.stringify({
      ...responseBody,
      callback: `nostr1+http://${keys.publicKey.toBech32()}${responseBody.callback.slice(destination.length)}`
    }))
  }
};
