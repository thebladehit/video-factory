import { useRef, useState } from 'react';
import { Clip, Project, TrackKind, fmtTime, projectDuration } from './model';

// Таймлайн — звичайні DOM-елементи з абсолютним позиціонуванням (left = start * pxPerSec).
// Вся взаємодія — pointer events: рух, трім за краї, снепінг до країв інших кліпів і плейхеда.
// Він не залежить від рушія рендеру — тільки редагує масив clips у JSON проєкту.

interface Props {
  project: Project;
  time: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onSeek: (t: number) => void;
  updateClip: (id: string, patch: Partial<Clip>) => void;
  onDropAsset: (assetId: string, track: TrackKind, at: number) => void;
  onDropFiles: (files: File[], at: number) => void;
}

const TRACKS: { kind: TrackKind; label: string }[] = [
  { kind: 'media', label: '🎞 Відео/Фото' },
  { kind: 'text', label: '💬 Субтитри' },
];
const HEADER_W = 110;
const SNAP_PX = 8;

export function Timeline(p: Props) {
  const [pps, setPps] = useState(60); // пікселів на секунду (зум)
  const scrollRef = useRef<HTMLDivElement>(null);
  const total = projectDuration(p.project) + 10;

  const xToTime = (clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - HEADER_W + el.scrollLeft) / pps);
  };

  const startDrag = (e: React.PointerEvent, clip: Clip, mode: 'move' | 'l' | 'r') => {
    e.stopPropagation();
    e.preventDefault();
    p.onSelect(clip.id);
    const x0 = e.clientX;
    const orig = { ...clip };
    const asset = p.project.assets.find((a) => a.id === clip.assetId);
    const srcLen = asset?.kind === 'video' ? asset.duration : Infinity;
    // точки прив'язки: краї інших кліпів + плейхед + нуль
    const snaps = [0, p.time, ...p.project.clips.filter((c) => c.id !== clip.id).flatMap((c) => [c.start, c.start + c.duration])];
    const snap = (v: number) => {
      for (const s of snaps) if (Math.abs(s - v) * pps < SNAP_PX) return s;
      return v;
    };

    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / pps;
      if (mode === 'move') {
        let start = Math.max(0, orig.start + dt);
        const sEnd = snap(start + orig.duration);
        const sStart = snap(start);
        if (sStart !== start) start = sStart;
        else if (sEnd !== start + orig.duration) start = sEnd - orig.duration;
        p.updateClip(clip.id, { start: Math.max(0, start) });
      } else if (mode === 'r') {
        let end = snap(orig.start + orig.duration + dt);
        const dur = Math.min(Math.max(0.2, end - orig.start), srcLen - orig.in);
        p.updateClip(clip.id, { duration: dur });
      } else {
        let newStart = snap(orig.start + dt);
        let d = newStart - orig.start;
        d = Math.max(d, -orig.start); // не лівіше нуля
        if (asset?.kind === 'video') d = Math.max(d, -orig.in); // не раніше початку джерела
        d = Math.min(d, orig.duration - 0.2);
        p.updateClip(clip.id, { start: orig.start + d, in: orig.in + d, duration: orig.duration - d });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const scrub = (e: React.PointerEvent) => {
    p.onSeek(xToTime(e.clientX));
    const move = (ev: PointerEvent) => p.onSeek(xToTime(ev.clientX));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onDrop = (e: React.DragEvent, track: TrackKind) => {
    e.preventDefault();
    const at = xToTime(e.clientX);
    const assetId = e.dataTransfer.getData('application/x-asset');
    if (assetId) p.onDropAsset(assetId, track, at);
    else if (e.dataTransfer.files.length) p.onDropFiles([...e.dataTransfer.files], at);
  };

  const ticks = [];
  const step = pps > 80 ? 1 : pps > 30 ? 2 : 5;
  for (let s = 0; s <= total; s += step) ticks.push(s);

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <span>Таймлайн</span>
        <label>зум <input type="range" min={15} max={200} value={pps} onChange={(e) => setPps(+e.target.value)} /></label>
        <span className="muted">тягни кліп · тягни краї для обрізки · перетягни файл/картинку з бібліотеки на доріжку · S — розрізати · Del — видалити · Space — play</span>
      </div>
      <div className="tl-scroll" ref={scrollRef}>
        <div style={{ width: HEADER_W + total * pps, position: 'relative' }}>
          <div className="tl-ruler" onPointerDown={scrub} style={{ marginLeft: HEADER_W }}>
            {ticks.map((s) => (
              <div key={s} className="tick" style={{ left: s * pps }}>{fmtTime(s).replace(/\.00$/, '')}</div>
            ))}
          </div>
          {TRACKS.map((tr) => (
            <div key={tr.kind} className="tl-track" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, tr.kind)}
              onPointerDown={(e) => { if (e.target === e.currentTarget) p.onSelect(null); }}>
              <div className="tl-head">{tr.label}</div>
              {p.project.clips.filter((c) => c.track === tr.kind).map((c) => {
                const asset = p.project.assets.find((a) => a.id === c.assetId);
                return (
                  <div key={c.id}
                    className={`clip ${c.track} ${asset?.kind ?? ''} ${p.selectedId === c.id ? 'sel' : ''}`}
                    style={{ left: HEADER_W + c.start * pps, width: Math.max(4, c.duration * pps),
                      backgroundImage: asset?.kind === 'image' ? `url(${asset.url})` : undefined }}
                    onPointerDown={(e) => startDrag(e, c, 'move')}>
                    <div className="h l" onPointerDown={(e) => startDrag(e, c, 'l')} />
                    <span className="clip-label">{c.text ?? asset?.name}</span>
                    <div className="h r" onPointerDown={(e) => startDrag(e, c, 'r')} />
                  </div>
                );
              })}
            </div>
          ))}
          <div className="playhead" style={{ left: HEADER_W + p.time * pps }} />
        </div>
      </div>
    </div>
  );
}
