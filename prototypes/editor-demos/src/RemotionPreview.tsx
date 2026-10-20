import { Player, PlayerRef } from '@remotion/player';
import { useEffect, useMemo, useRef } from 'react';
import { AbsoluteFill, Img, Sequence, Video, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Project, projectDuration } from './model';

// Демо B: відео — це React-компонент. Кадр = функція від номера кадру (useCurrentFrame()).
// <Player> програє його в браузері; на сервері @remotion/renderer відкриває той самий
// компонент у headless Chrome, робить скріншот кожного кадру і склеює через FFmpeg.

export const VideoComposition: React.FC<{ project: Project }> = ({ project }) => {
  const { fps } = useVideoConfig();
  const f = (s: number) => Math.round(s * fps);
  return (
    <AbsoluteFill style={{ background: 'black' }}>
      {project.clips.filter((c) => c.track === 'media').sort((a, b) => a.start - b.start).map((c) => {
        const a = project.assets.find((x) => x.id === c.assetId);
        if (!a) return null;
        return (
          <Sequence key={c.id} from={f(c.start)} durationInFrames={Math.max(1, f(c.duration))} layout="none">
            <FadeIn>
              {a.kind === 'image'
                ? <KenBurns src={a.url} durationInFrames={f(c.duration)} />
                : <Video src={a.url} trimBefore={f(c.in)} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
            </FadeIn>
          </Sequence>
        );
      })}
      {project.clips.filter((c) => c.track === 'text').map((c) => (
        <Sequence key={c.id} from={f(c.start)} durationInFrames={Math.max(1, f(c.duration))} layout="none">
          <WordByWordCaption text={c.text ?? ''} durationInFrames={f(c.duration)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

const FadeIn: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <AbsoluteFill style={{ opacity: interpolate(frame, [0, 0.3 * fps], [0, 1], { extrapolateRight: 'clamp' }) }}>{children}</AbsoluteFill>;
};

const KenBurns: React.FC<{ src: string; durationInFrames: number }> = ({ src, durationInFrames }) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, durationInFrames], [1, 1.08]);
  return <Img src={src} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${scale})` }} />;
};

// Те, що в FFmpeg робити боляче, а тут — 15 рядків: TikTok-субтитри, що підсвічують слово за словом.
const WordByWordCaption: React.FC<{ text: string; durationInFrames: number }> = ({ text, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const per = durationInFrames / Math.max(1, words.length);
  const size = Math.min(width, height) * 0.075;
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: height * 0.22 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: size * 0.3, justifyContent: 'center', maxWidth: width * 0.85,
        font: `900 ${size}px system-ui, sans-serif`, WebkitTextStroke: `${size * 0.09}px black`, paintOrder: 'stroke fill' }}>
        {words.map((w, i) => {
          const s = spring({ frame: frame - i * per, fps, config: { damping: 12 } });
          const active = frame >= i * per && frame < (i + 1) * per;
          return (
            <span key={i} style={{ transform: `scale(${0.6 + 0.4 * s})`, opacity: s, color: active ? '#feca57' : 'white' }}>{w}</span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

interface Props { project: Project; time: number; onTime: (t: number) => void; seekToken: number }

export function RemotionPreview({ project, time, onTime, seekToken }: Props) {
  const ref = useRef<PlayerRef>(null);
  const inputProps = useMemo(() => ({ project }), [project]);
  const duration = Math.max(1, Math.round(projectDuration(project) * project.fps));

  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    const h = (e: { detail: { frame: number } }) => onTime(e.detail.frame / project.fps);
    p.addEventListener('frameupdate', h);
    return () => p.removeEventListener('frameupdate', h);
  }, [onTime, project.fps]);

  // перемотка з таймлайну → плеєр
  useEffect(() => {
    const p = ref.current;
    if (p && !p.isPlaying()) p.seekTo(Math.round(time * project.fps));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekToken]);

  return (
    <Player ref={ref} component={VideoComposition} inputProps={inputProps}
      durationInFrames={duration} fps={project.fps}
      compositionWidth={project.width} compositionHeight={project.height}
      controls clickToPlay={false} spaceKeyToPlayOrPause={false}
      className="preview-canvas"
      style={{ height: '100%', maxWidth: '100%', aspectRatio: `${project.width} / ${project.height}` }} />
  );
}
