/* Stashly DOM-only scanner with original-photo resolution through Facebook photo permalinks. */
const REPO_URL = "https://github.com/shahriar-ahmed-seam/Stashly";
const FB_PHOTOS_URL = "https://www.facebook.com/me/photos_albums";
const FB_HOSTS = ["www.facebook.com", "web.facebook.com"];
let collectedPhotos = [];
let stopRequested = false;
let scanning = false;
let downloading = false;
function $(id) { return document.getElementById(id); }
function setStatus(ok, text) {
  const el = $("status");
  el.className = "pill " + (ok ? "pill--ok" : "pill--warn");
  $("status-text").textContent = text;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function getActiveFacebookTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return null;
  try { return FB_HOSTS.includes(new URL(tab.url).hostname) ? tab : null; }
  catch { return null; }
}
async function collectVisibleImages(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: "ISOLATED",
    func: () => {
      const found = [];
      const add = (value, img, permalink) => {
        if (!value) return;
        try {
          const u = new URL(value, location.href);
          if (!/^https?:$/.test(u.protocol) ||
              !(u.hostname.endsWith("fbcdn.net") || u.hostname.endsWith("fbsbx.com"))) return;
          const rect = img.getBoundingClientRect();
          const width = Math.max(img.naturalWidth || 0, img.width || 0, rect.width || 0);
          const height = Math.max(img.naturalHeight || 0, img.height || 0, rect.height || 0);
          if (width < 100 || height < 100) return;
          found.push({ url: u.href, permalink, width, height, alt: img.alt || "" });
        } catch {}
      };
      for (const img of document.images) {
        // Only collect actual photo cards, never profile branding or cover images.
        const anchor = img.closest('a[href*="photo.php"], a[href*="/photo/"], a[href*="/photos/"]');
        let permalink = anchor?.href || "";
        if (!permalink) continue;
        try {
          const parsed = new URL(permalink, location.href);
          const validHost = parsed.hostname === location.hostname;
          const validRoute = /\/photo\.php$/.test(parsed.pathname) || /\/photos?\//.test(parsed.pathname);
          if (!validHost || !validRoute) continue;
          if (/\/photo\.php$/.test(parsed.pathname) && !parsed.searchParams.has("fbid")) continue;
          permalink = parsed.href;
        } catch { continue; }
        add(img.currentSrc, img, permalink);
        add(img.src, img, permalink);
        add(img.getAttribute("data-src"), img, permalink);
        const srcset = img.getAttribute("srcset") || "";
        for (const part of srcset.split(",")) add(part.trim().split(/\s+/)[0], img, permalink);
      }
      return {
        photos: found,
        scrollY: window.scrollY,
        viewport: window.innerHeight,
        pageHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
      };
    }
  });
  return results?.[0]?.result;
}
async function scrollOneStep(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId }, world: "ISOLATED",
    func: () => window.scrollBy(0, Math.max(450, Math.floor(window.innerHeight * 0.72)))
  });
}
async function scanPage() {
  const tab = await getActiveFacebookTab();
  if (!tab) throw new Error("Mở trang Facebook có ảnh trước khi quét.");
  const byUrl = new Map(collectedPhotos.map(photo => [photo.permalink || photo.url, photo]));
  let stableAtBottom = 0;
  let previousCount = byUrl.size;
  const maxSteps = 60;
  for (let step = 0; step < maxSteps; step++) {
    if (stopRequested) break;
    const snapshot = await collectVisibleImages(tab.id);
    if (!snapshot) throw new Error("Không đọc được nội dung trang Facebook.");
    for (const photo of snapshot.photos) {
      const key = photo.permalink || photo.url;
      const old = byUrl.get(key);
      byUrl.set(key, { ...old, ...photo, permalink: photo.permalink || old?.permalink || "" });
    }
    collectedPhotos = [...byUrl.values()];
    $("resume-count").textContent = String(collectedPhotos.length);
    $("scan-result").textContent = "Đang quét: lượt " + (step + 1) + "/" + maxSteps +
      " · tìm thấy " + collectedPhotos.length + " ảnh.";
    const atBottom = snapshot.scrollY + snapshot.viewport >= snapshot.pageHeight - 100;
    if (atBottom && byUrl.size === previousCount) stableAtBottom++;
    else stableAtBottom = 0;
    previousCount = byUrl.size;
    if (atBottom && stableAtBottom >= 5) break;
    if (stopRequested) break;
    await scrollOneStep(tab.id);
    await sleep(750);
  }
  if (!stopRequested) {
    const finalSnapshot = await collectVisibleImages(tab.id);
    for (const photo of (finalSnapshot?.photos || [])) {
      const key = photo.permalink || photo.url;
      const old = byUrl.get(key);
      byUrl.set(key, { ...old, ...photo, permalink: photo.permalink || old?.permalink || "" });
    }
    collectedPhotos = [...byUrl.values()];
  }
  return { count: collectedPhotos.length, stopped: stopRequested };
}
function waitForTab(tabId, timeoutMs = 18000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => done(new Error("Facebook tải trang ảnh quá thời gian.")), timeoutMs);
    function done(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    }
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === "complete") done();
    }).catch(done);
  });
}
async function resolveOriginalPhoto(photo, viewerTabId) {
  if (!photo.permalink) return { url: photo.url, original: false, reason: "Không tìm thấy liên kết ảnh riêng" };
  try {
    await chrome.tabs.update(viewerTabId, { url: photo.permalink, active: false });
    await waitForTab(viewerTabId);
    await sleep(1100);
    const results = await chrome.scripting.executeScript({
      target: { tabId: viewerTabId }, world: "ISOLATED",
      func: () => {
        const candidates = [];
        const add = (value, width = 0, height = 0) => {
          if (!value) return;
          try {
            const u = new URL(value, location.href);
            if (!(u.hostname.endsWith("fbcdn.net") || u.hostname.endsWith("fbsbx.com"))) return;
            if (!/^https?:$/.test(u.protocol)) return;
            candidates.push({ url: u.href, width, height, area: width * height });
          } catch {}
        };
        const og = document.querySelector('meta[property="og:image"]')?.content;
        if (og) add(og);
        for (const img of document.images) {
          const r = img.getBoundingClientRect();
          add(img.currentSrc || img.src, Math.max(img.naturalWidth || 0, r.width || 0), Math.max(img.naturalHeight || 0, r.height || 0));
          const srcset = img.getAttribute("srcset") || "";
          for (const part of srcset.split(",")) add(part.trim().split(/\s+/)[0], img.naturalWidth || 0, img.naturalHeight || 0);
        }
        candidates.sort((a, b) => b.area - a.area);
        return candidates[0] || null;
      }
    });
    const best = results?.[0]?.result;
    if (best?.url && best.area >= 500 * 500) return { url: best.url, original: true, width: best.width, height: best.height };
    if (best?.url && best.area > photo.width * photo.height) return { url: best.url, original: true, width: best.width, height: best.height };
    return { url: photo.url, original: false, reason: "Facebook không cung cấp ảnh lớn hơn thumbnail" };
  } catch (error) {
    return { url: photo.url, original: false, reason: error.message || "Không mở được liên kết ảnh" };
  }
}
async function refreshStats() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let onFacebook = false;
  try { onFacebook = !!tab?.url && FB_HOSTS.includes(new URL(tab.url).hostname); } catch {}
  setStatus(onFacebook, onFacebook ? "Sẵn sàng quét" : "Mở Facebook");
  $("hint").textContent = onFacebook
    ? "Lấy liên kết ảnh riêng để tìm bản có độ phân giải cao hơn. Có thể dừng bất cứ lúc nào."
    : "Mở album hoặc trang ảnh Facebook, sau đó bấm Quét ảnh.";
  $("version").textContent = "v" + chrome.runtime.getManifest().version;
  $("github").href = REPO_URL;
  const stored = await chrome.storage.local.get("stashlyDownloadedCount");
  $("downloaded-count").textContent = String(stored.stashlyDownloadedCount || 0);
  $("resume-count").textContent = String(collectedPhotos.length);
}
$("scan-photos").addEventListener("click", async () => {
  if (scanning || downloading) return;
  scanning = true; stopRequested = false; collectedPhotos = [];
  $("download-photos").disabled = true;
  $("scan-photos").disabled = true; $("stop-scan").hidden = false;
  $("scan-result").textContent = "Đang bắt đầu quét...";
  try {
    const result = await scanPage();
    $("scan-result").textContent = (result.stopped ? "Đã dừng" : "Quét hoàn tất") +
      " · giữ lại " + result.count + " ảnh (có liên kết ảnh riêng: " +
      collectedPhotos.filter(p => p.permalink).length + ").";
    $("download-photos").disabled = result.count === 0 || downloading;
  } catch (error) {
    $("scan-result").textContent = "Lỗi quét: " + (error.message || "Không xác định");
    $("download-photos").disabled = collectedPhotos.length === 0 || downloading;
  } finally {
    scanning = false; $("scan-photos").disabled = false;
    $("stop-scan").hidden = true; $("stop-scan").disabled = false;
    $("stop-scan").textContent = "Dừng quét";
    $("resume-count").textContent = String(collectedPhotos.length);
  }
});
$("stop-scan").addEventListener("click", () => {
  if (!scanning) return;
  stopRequested = true; $("stop-scan").disabled = true;
  $("stop-scan").textContent = "Đang dừng...";
  $("scan-result").textContent = "Đang dừng thu thập ảnh. Lượt tải đã bắt đầu sẽ tiếp tục, không bị hủy.";
});
$("download-photos").addEventListener("click", async () => {
  if (downloading || scanning || collectedPhotos.length === 0) return;
  downloading = true;
  const photosToDownload = [...collectedPhotos];
  const btn = $("download-photos"); btn.disabled = true;
  $("scan-photos").disabled = true;
  $("stop-scan").hidden = true;
  $("hint").textContent = "Đang tải ảnh. Dừng quét chỉ dùng cho giai đoạn thu thập, không hủy lượt tải.";
  let done = 0, failed = 0, originals = 0, fallbacks = 0;
  let viewerTabId = null;
  const photoTab = await chrome.tabs.create({ url: "about:blank", active: false });
  viewerTabId = photoTab.id;
  try {
    for (let i = 0; i < photosToDownload.length; i++) {
      const photo = photosToDownload[i];
      try {
        $("scan-result").textContent = "Đang lấy ảnh chất lượng cao " + (i + 1) + "/" + photosToDownload.length + "...";
        const resolved = await resolveOriginalPhoto(photo, viewerTabId);
        if (resolved.original) originals++; else fallbacks++;
        await chrome.downloads.download({
          url: resolved.url,
          filename: "V-Florist/" + String(i + 1).padStart(4, "0") + ".jpg",
          conflictAction: "uniquify", saveAs: false
        });
        done++;
      } catch (error) {
        failed++; console.error("[Stashly] Download failed:", error);
      }
      $("scan-result").textContent = "Đã gửi tải " + done + "/" + photosToDownload.length +
        " · ảnh gốc " + originals + " · thumbnail/dự phòng " + fallbacks + (failed ? " · lỗi " + failed : "");
      await sleep(250);
    }
  } finally {
    if (viewerTabId) chrome.tabs.remove(viewerTabId).catch(() => {});
  }
  const current = await chrome.storage.local.get("stashlyDownloadedCount");
  await chrome.storage.local.set({ stashlyDownloadedCount: (current.stashlyDownloadedCount || 0) + done });
  $("scan-result").textContent = "Hoàn tất: " + done + " ảnh · ảnh độ phân giải cao " + originals +
    " · dự phòng thumbnail " + fallbacks + (failed ? " · lỗi " + failed : "") + ".";
  downloading = false;
  $("scan-photos").disabled = false;
  btn.disabled = collectedPhotos.length === 0;
  $("hint").textContent = "Đã tải xong. Có thể quét lại hoặc tải lại danh sách ảnh.";
  await refreshStats();
});
$("open-fb").addEventListener("click", () => { chrome.tabs.create({ url: FB_PHOTOS_URL }); window.close(); });
$("open-options").addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else chrome.tabs.create({ url: chrome.runtime.getURL("pages/options/index.html") });
});
refreshStats();
