async () => {
  const pc = window.__pc; if (!pc) return { err: 'no pc' };
  const sdp = pc.remoteDescription ? pc.remoteDescription.sdp : '';
  const lines = sdp.split("\n").filter(l => /a=rtpmap:111|a=fmtp:111|m=audio|a=maxptime|useinbandfec|usedtx/.test(l));
  const s = await pc.getStats(); let codec = null, outb = null;
  s.forEach(r => {
    if (r.type === 'codec' && r.mimeType && r.mimeType.includes('opus')) codec = r;
    if (r.type === 'outbound-rtp' && r.kind === 'audio') outb = r;
  });
  const sender = pc.getSenders().find(x => x.track);
  const params = sender ? sender.getParameters() : null;
  return {
    remoteSdpLines: lines,
    codec: codec ? { mime: codec.mimeType, clock: codec.clockRate, ch: codec.channels, fmtp: codec.sdpFmtpLine } : null,
    encodings: params ? params.encodings : null,
    targetBitrate: outb ? outb.targetBitrate : null
  };
}
