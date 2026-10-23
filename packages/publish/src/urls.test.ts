import { describe, expect, it } from 'vitest';
import { parsePostUrl } from './urls';

const id = (platformPostId: string | null) => ({ platformPostId });

describe('parsePostUrl', () => {
  it.each([
    'https://www.youtube.com/watch?v=abcDEF12345',
    'https://youtu.be/abcDEF12345?si=x',
    'https://www.youtube.com/shorts/abcDEF12345',
    'https://m.youtube.com/watch?v=abcDEF12345&t=3',
  ])('youtube %s', (u) => expect(parsePostUrl('youtube', u)).toEqual(id('abcDEF12345')));

  it('tiktok', () => {
    expect(parsePostUrl('tiktok', 'https://www.tiktok.com/@u/video/7311111111111111111?is_from_webapp=1')).toEqual(
      id('7311111111111111111'),
    );
    expect(parsePostUrl('tiktok', 'https://vm.tiktok.com/ZMabc/')).toEqual(id(null));
    expect(parsePostUrl('tiktok', 'https://vt.tiktok.com/ZSabc/')).toEqual(id(null));
  });

  it.each([
    'https://www.instagram.com/reel/C1abc_-9/?igsh=x',
    'https://instagram.com/reels/C1abc_-9/',
    'https://www.instagram.com/p/C1abc_-9/',
  ])('instagram %s', (u) => expect(parsePostUrl('instagram', u)).toEqual(id('C1abc_-9')));

  it('facebook', () => {
    expect(parsePostUrl('facebook', 'https://www.facebook.com/reel/123')).toEqual(id('123'));
    expect(parsePostUrl('facebook', 'https://facebook.com/watch/?v=123')).toEqual(id('123'));
    expect(parsePostUrl('facebook', 'https://www.facebook.com/MyPage/videos/123/')).toEqual(id('123'));
    expect(parsePostUrl('facebook', 'https://fb.watch/abc')).toEqual(id(null));
  });

  it('чужа платформа / сміття → null', () => {
    expect(parsePostUrl('youtube', 'https://www.tiktok.com/@u/video/1')).toBeNull();
    expect(parsePostUrl('instagram', 'https://youtu.be/abcDEF12345')).toBeNull();
    expect(parsePostUrl('youtube', 'not a url')).toBeNull();
    expect(parsePostUrl('youtube', 'https://evilyoutube.com/watch?v=abcDEF12345')).toBeNull();
    expect(parsePostUrl('youtube', 'javascript:alert(1)')).toBeNull();
  });
});
