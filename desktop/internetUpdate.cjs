const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const repository = 'Seal1nThePot/HIVE-Md-editor';
const releaseApi = `https://api.github.com/repos/${repository}/releases/latest`;
const releaseHost = 'github.com';
const downloadHosts = new Set([releaseHost, 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const redirectCodes = new Set([301, 302, 303, 307, 308]);
const manifestName = 'update.hive.json';
const archiveName = 'app.asar';

async function discard(response) {
  await response.body?.cancel().catch(() => {});
}

async function request(fetchFile, url, hosts, signal, accept) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.has(url.hostname)) {
      throw new Error('更新链接不属于可信的 GitHub 发布源。');
    }
    let response;
    try {
      response = await fetchFile(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'HIVE-Desktop-Update', Accept: accept } });
    } catch {
      throw new Error('无法连接 GitHub 更新源，请检查网络后重试。');
    }
    if (!redirectCodes.has(response.status)) return response;
    const location = response.headers.get('location');
    await discard(response);
    if (!location) break;
    url = new URL(location, url);
  }
  throw new Error('GitHub 更新链接重定向失败。');
}

async function readJson(response, limit) {
  if (!response.ok || !response.body) {
    await discard(response);
    throw new Error(`无法读取 GitHub 更新信息（HTTP ${response.status}）。`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error('GitHub 更新信息超过允许大小。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('GitHub 更新信息格式无效。');
  }
}

function createInternetUpdate(fetchFile = globalThis.fetch) {
  const download = (url, signal) => request(fetchFile, url, downloadHosts, signal, 'application/octet-stream');

  return {
    async latest() {
      const signal = AbortSignal.timeout(20000);
      const response = await request(fetchFile, new URL(releaseApi), new Set(['api.github.com']), signal, 'application/vnd.github+json');
      if (response.status === 404) {
        await discard(response);
        return null;
      }
      const release = await readJson(response, 512 * 1024);
      const tag = release?.tag_name;
      if (typeof tag !== 'string' || !/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(tag) || release.draft || release.prerelease) {
        throw new Error('GitHub 稳定版发布记录无效。');
      }
      const assets = release.assets;
      if (!Array.isArray(assets)) throw new Error('GitHub 发布附件信息无效。');
      const findAsset = name => assets.find(asset => asset?.name === name && asset.state === 'uploaded');
      if (!findAsset(manifestName) || !findAsset(archiveName)) return null;
      const base = `https://${releaseHost}/${repository}/releases/download/${encodeURIComponent(tag)}/`;
      const manifest = await readJson(await download(new URL(manifestName, base), signal), 64 * 1024);
      if (findAsset(archiveName).size !== manifest?.bytes || manifest?.build?.version !== tag.replace(/^v/, '').split(/[-+]/, 1)[0]) {
        throw new Error('GitHub 更新清单与发布附件不匹配。');
      }
      return { manifest, archiveUrl: new URL(archiveName, base) };
    },

    async stage(release, destination, rawFs) {
      const signal = AbortSignal.timeout(10 * 60 * 1000);
      const response = await download(release.archiveUrl, signal);
      if (!response.ok || !response.body) {
        await discard(response);
        throw new Error(`无法下载 GitHub 更新包（HTTP ${response.status}）。`);
      }
      const limit = release.manifest.bytes;
      let received = 0;
      const count = new Transform({
        transform(chunk, _encoding, done) {
          received += chunk.length;
          if (received > limit) return done(new Error('下载的更新包大小与清单不符。'));
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), count, rawFs.createWriteStream(destination, { flags: 'wx' }), { signal });
      if (received !== limit) throw new Error('下载的更新包不完整，请重试。');
    },
  };
}

module.exports = { createInternetUpdate };
