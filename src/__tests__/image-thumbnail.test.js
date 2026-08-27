const { toThumbnailUrl } = require('../services/image-thumbnail');

describe('toThumbnailUrl', () => {
  test('returns null/undefined unchanged', () => {
    expect(toThumbnailUrl(null)).toBeNull();
    expect(toThumbnailUrl(undefined)).toBeUndefined();
  });

  test('appends w=300 to Indian Express URLs with no existing query', () => {
    expect(toThumbnailUrl('https://images.indianexpress.com/2026/08/photo.jpg')).toBe(
      'https://images.indianexpress.com/2026/08/photo.jpg?w=300'
    );
  });

  test('appends w=300 with & when Indian Express URL already has a query', () => {
    expect(toThumbnailUrl('https://images.indianexpress.com/2026/08/photo.jpg?v=2')).toBe(
      'https://images.indianexpress.com/2026/08/photo.jpg?v=2&w=300'
    );
  });

  test('rewrites Times of India photo URLs to the /thumb/ endpoint', () => {
    expect(
      toThumbnailUrl('https://static.toiimg.com/photo/msid-133509010,imgsize-86812.cms')
    ).toBe('https://static.toiimg.com/thumb/msid-133509010,width-300,height-168,resizemode-4.cms');
  });

  test('rewrites Economic Times photo URLs the same way (same Times Internet pattern)', () => {
    expect(toThumbnailUrl('https://img.etimg.com/photo/msid-999,imgsize-123.cms')).toBe(
      'https://img.etimg.com/thumb/msid-999,width-300,height-168,resizemode-4.cms'
    );
  });

  test('leaves an already-thumbnailed Times Internet URL unchanged (no /photo/ match)', () => {
    const url = 'https://static.toiimg.com/thumb/msid-1,width-300,height-168,resizemode-4.cms';
    expect(toThumbnailUrl(url)).toBe(url);
  });

  test('leaves URLs from unknown publishers unchanged', () => {
    const url = 'https://th-i.thgim.com/public/incoming/foo/article.jpg';
    expect(toThumbnailUrl(url)).toBe(url);
  });

  test('does not match a Times Internet look-alike URL with the wrong shape', () => {
    const url = 'https://static.toiimg.com/photo/msid-abc,imgsize-86812.cms';
    expect(toThumbnailUrl(url)).toBe(url);
  });
});
