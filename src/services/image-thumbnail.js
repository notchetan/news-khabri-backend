// Rewrites a publisher's full-size image URL to request a small thumbnail
// variant instead, using each publisher's own resize capability - avoids
// downloading multi-MB originals for what's rendered as a small list thumb.
// Publishers with no known resize pattern are left as-is.

const TIMES_INTERNET_PHOTO = /^(https?:\/\/[^/]+)\/photo\/msid-(\d+),imgsize-\d+\.cms$/;

function toThumbnailUrl(url) {
  if (!url) return url;

  // Indian Express - WordPress/Jetpack-style width query param.
  if (url.includes('indianexpress.com')) {
    return `${url}${url.includes('?') ? '&' : '?'}w=300`;
  }

  // Times of India / Economic Times (Times Internet network) - dedicated
  // /thumb/ endpoint alongside the full-size /photo/ one.
  const match = url.match(TIMES_INTERNET_PHOTO);
  if (match) {
    const [, origin, msid] = match;
    return `${origin}/thumb/msid-${msid},width-300,height-168,resizemode-4.cms`;
  }

  return url;
}

module.exports = { toThumbnailUrl };
