/**
 * Медіаелементи прев'ю: фото — по одному на asset, відео й звук — по елементу на кліп (кожен має свій час).
 * Помилка завантаження → один запит свіжого URL; повторна помилка → «браузер не може показати цей файл».
 */
export class MediaCache {
  private images = new Map<string, HTMLImageElement>();
  private videos = new Map<string, HTMLVideoElement>();
  private audios = new Map<string, HTMLAudioElement>();
  private refreshed = new Set<string>();
  readonly unsupported = new Set<string>();

  constructor(
    private readonly o: {
      /** Попросити свіжий URL (протух підпис) */
      onRefresh(assetId: string): void;
      /** Кадр став доступним — перемалювати */
      onFrame(): void;
    },
  ) {}

  private failed(assetId: string) {
    if (!this.refreshed.has(assetId)) {
      this.refreshed.add(assetId);
      this.o.onRefresh(assetId);
    } else {
      this.unsupported.add(assetId);
      this.o.onFrame();
    }
  }

  image(assetId: string, url: string): HTMLImageElement {
    let img = this.images.get(assetId);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => this.o.onFrame();
      img.onerror = () => this.failed(assetId);
      this.images.set(assetId, img);
    }
    if (img.dataset.url !== url) {
      img.dataset.url = url;
      img.src = url;
    }
    return img;
  }

  video(clipId: string, assetId: string, url: string): HTMLVideoElement {
    let v = this.videos.get(clipId);
    if (!v) {
      v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      v.onloadeddata = () => this.o.onFrame();
      v.onseeked = () => this.o.onFrame();
      v.onerror = () => this.failed(assetId);
      this.videos.set(clipId, v);
    }
    if (v.dataset.url !== url) {
      const at = v.currentTime;
      v.dataset.url = url;
      v.src = url;
      if (at) v.currentTime = at;
    }
    return v;
  }

  audio(itemId: string, assetId: string, url: string): HTMLAudioElement {
    let a = this.audios.get(itemId);
    if (!a) {
      a = document.createElement('audio');
      a.preload = 'auto';
      a.crossOrigin = 'anonymous';
      a.onerror = () => this.failed(assetId);
      this.audios.set(itemId, a);
    }
    if (a.dataset.url !== url) {
      a.dataset.url = url;
      a.src = url;
    }
    return a;
  }

  /** Новий URL прийшов — дати файлу ще один шанс. */
  forgetFailure(assetId: string) {
    this.unsupported.delete(assetId);
  }

  allVideos() {
    return this.videos;
  }

  allAudios() {
    return this.audios;
  }

  /** Прибрати елементи кліпів, яких більше немає. */
  prune(live: { images: Set<string>; videos: Set<string>; audios: Set<string> }) {
    const drop = <T extends HTMLMediaElement | HTMLImageElement>(m: Map<string, T>, keep: Set<string>) => {
      for (const [k, el] of m)
        if (!keep.has(k)) {
          if (el instanceof HTMLMediaElement) el.pause();
          el.removeAttribute('src');
          m.delete(k);
        }
    };
    drop(this.images, live.images);
    drop(this.videos, live.videos);
    drop(this.audios, live.audios);
  }

  destroy() {
    this.prune({ images: new Set(), videos: new Set(), audios: new Set() });
  }
}
