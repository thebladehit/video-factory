import { useCallback, useEffect, useMemo, useState } from 'react';
import { Asset, Clip, FORMATS, FormatKey, Project, TrackKind, fmtTime, projectDuration, uid } from './model';
import { assetFromFile, makeSampleImages, makeSampleVideo } from './samples';
import { Timeline } from './Timeline';
import { CanvasPreview } from './CanvasPreview';
import { RemotionPreview } from './RemotionPreview';
import { buildFfmpegCommand } from './ffmpegCommand';
import { exportInBrowser } from './browserExport';

type Engine = 'A' | 'B' | 'C';

const ENGINES: Record<Engine, { title: string; sub: string }> = {
  A: { title: 'A · Свій canvas-прев\'ю + FFmpeg на сервері', sub: 'прев\'ю ≈ рендер' },
  B: { title: 'B · Remotion (React → відео)', sub: 'прев\'ю = рендер' },
  C: { title: 'C · Рендер у браузері (WebCodecs)', sub: 'без сервера' },
};

export function App() {
  const [engine, setEngine] = useState<Engine>('A');
  const [format, setFormat] = useState<FormatKey>('short');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [time, setTime] = useState(1);
  const [seekToken, setSeekToken] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const project: Project = useMemo(
    () => ({ width: FORMATS[format].width, height: FORMATS[format].height, fps: 30, assets, clips }),
    [format, assets, clips],
  );

  // стартовий проєкт: 4 "AI-картинки", стокове відео і субтитри
  useEffect(() => {
    (async () => {
      const imgs = await makeSampleImages();
      const vid = await makeSampleVideo();
      setAssets([...imgs, vid]);
      setClips([
        { id: uid(), track: 'media', start: 0, duration: 3, in: 0, assetId: imgs[0].id },
        { id: uid(), track: 'media', start: 3, duration: 3, in: 0, assetId: imgs[1].id },
        { id: uid(), track: 'media', start: 6, duration: 4, in: 1, assetId: vid.id },
        { id: uid(), track: 'media', start: 10, duration: 3, in: 0, assetId: imgs[2].id },
        { id: uid(), track: 'media', start: 13, duration: 3, in: 0, assetId: imgs[3].id },
        { id: uid(), track: 'text', start: 0.2, duration: 2.6, in: 0, text: 'Ти робиш це неправильно' },
        { id: uid(), track: 'text', start: 3.2, duration: 2.6, in: 0, text: 'Монтаж забирає години' },
        { id: uid(), track: 'text', start: 6.2, duration: 3.6, in: 0, text: 'А AI робить це за хвилину' },
        { id: uid(), track: 'text', start: 13.2, duration: 2.6, in: 0, text: 'Підпишись!' },
      ]);
      setLoading(false);
    })();
  }, []);

  const updateClip = useCallback((id: string, patch: Partial<Clip>) =>
    setClips((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c))), []);

  const seek = (t: number) => { setPlaying(false); setTime(t); setSeekToken((x) => x + 1); };

  const addAssetClip = (a: Asset, track: TrackKind, at: number) => {
    if (track === 'text') return;
    const duration = a.kind === 'video' ? Math.min(a.duration, 5) : 3;
    const c: Clip = { id: uid(), track: 'media', start: at, duration, in: 0, assetId: a.id };
    setClips((cs) => [...cs, c]);
    setSelectedId(c.id);
  };

  const addFiles = async (files: File[], at?: number) => {
    let pos = at;
    for (const f of files) {
      const a = await assetFromFile(f);
      if (!a) continue;
      setAssets((as) => [...as, a]); // у реальному додатку: upload у S3 + запис у бібліотеку з тегами
      if (pos !== undefined) { addAssetClip(a, 'media', pos); pos += a.kind === 'video' ? Math.min(a.duration, 5) : 3; }
    }
  };

  const split = () => {
    const c = clips.find((x) => x.id === selectedId);
    if (!c || time <= c.start + 0.05 || time >= c.start + c.duration - 0.05) return;
    const left = time - c.start;
    const right: Clip = { ...c, id: uid(), start: time, in: c.in + left, duration: c.duration - left };
    setClips((cs) => [...cs.map((x) => (x.id === c.id ? { ...x, duration: left } : x)), right]);
  };
  const remove = () => { setClips((cs) => cs.filter((c) => c.id !== selectedId)); setSelectedId(null); };
  const addText = () => {
    const c: Clip = { id: uid(), track: 'text', start: time, duration: 2, in: 0, text: 'Новий текст' };
    setClips((cs) => [...cs, c]);
    setSelectedId(c.id);
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 's' || e.key === 'S' || e.key === 'і' || e.key === 'І') split();
      if (e.key === 'Delete' || e.key === 'Backspace') remove();
      if (e.key === ' ' && engine !== 'B') { e.preventDefault(); setPlaying((p) => !p); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const selected = clips.find((c) => c.id === selectedId);
  const onRemotionTime = useCallback((t: number) => setTime(t), []);

  if (loading) return <div className="loading">Генерую тестові картинки та відео…</div>;

  return (
    <div className="app">
      <header>
        <b>🎬 Демо монтажу в браузері</b>
        <nav>
          {(Object.keys(ENGINES) as Engine[]).map((k) => (
            <button key={k} className={engine === k ? 'on' : ''} onClick={() => { setPlaying(false); setEngine(k); }}>
              {ENGINES[k].title}<small>{ENGINES[k].sub}</small>
            </button>
          ))}
        </nav>
        <select value={format} onChange={(e) => setFormat(e.target.value as FormatKey)}>
          {(Object.keys(FORMATS) as FormatKey[]).map((k) => <option key={k} value={k}>{FORMATS[k].label}</option>)}
        </select>
      </header>

      <aside className="library" onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); }}>
        <h3>Бібліотека</h3>
        <p className="muted">Перетягни сюди свої фото/відео з робочого столу. Звідси — тягни на таймлайн.</p>
        <div className="assets">
          {assets.map((a) => (
            <div key={a.id} className="asset" draggable title={a.name}
              onDragStart={(e) => e.dataTransfer.setData('application/x-asset', a.id)}
              onDoubleClick={() => addAssetClip(a, 'media', projectDuration(project))}>
              {a.kind === 'image' ? <img src={a.url} /> : <video src={a.url} muted />}
              <span>{a.kind === 'video' ? `▶ ${a.duration.toFixed(1)}s` : '🖼'} {a.name}</span>
            </div>
          ))}
        </div>
        <label className="upload">+ Додати файли<input type="file" multiple accept="image/*,video/*" hidden onChange={(e) => addFiles([...(e.target.files ?? [])])} /></label>
      </aside>

      <main className="stage">
        <div className="preview-wrap">
          {engine === 'B'
            ? <RemotionPreview project={project} time={time} onTime={onRemotionTime} seekToken={seekToken} />
            : <CanvasPreview project={project} time={time} playing={playing} setTime={setTime} setPlaying={setPlaying} />}
        </div>
        <div className="transport">
          {engine !== 'B' && <button onClick={() => setPlaying((p) => !p)}>{playing ? '⏸' : '▶'}</button>}
          <span className="time">{fmtTime(time)} / {fmtTime(projectDuration(project))}</span>
          <button onClick={split} disabled={!selected}>✂ Розрізати (S)</button>
          <button onClick={remove} disabled={!selected}>🗑 Видалити</button>
          <button onClick={addText}>＋ Текст</button>
          {selected?.track === 'text' && (
            <input value={selected.text} onChange={(e) => updateClip(selected.id, { text: e.target.value })} />
          )}
        </div>
      </main>

      <aside className="explain">
        <Explain engine={engine} project={project} />
      </aside>

      <Timeline project={project} time={time} selectedId={selectedId} onSelect={setSelectedId} onSeek={seek}
        updateClip={updateClip} onDropAsset={(id, tr, at) => { const a = assets.find((x) => x.id === id); if (a) addAssetClip(a, tr, at); }}
        onDropFiles={(f, at) => addFiles(f, at)} />
    </div>
  );
}

function Explain({ engine, project }: { engine: Engine; project: Project }) {
  const [tab, setTab] = useState<'how' | 'code'>('how');
  return (
    <>
      <div className="explain-tabs">
        <button className={tab === 'how' ? 'on' : ''} onClick={() => setTab('how')}>Як це працює</button>
        <button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>
          {engine === 'A' ? 'FFmpeg-команда' : engine === 'B' ? 'Код композиції' : 'Експорт'}
        </button>
      </div>
      {tab === 'how' ? <How engine={engine} /> : engine === 'A'
        ? <><p className="muted">Ця команда генерується з JSON проєкту в реальному часі — посунь кліп і подивись, як вона зміниться. Сервер виконує її в черзі задач.</p><pre>{buildFfmpegCommand(project)}</pre><details><summary>JSON проєкту</summary><pre>{JSON.stringify({ ...project, assets: project.assets.map((a) => ({ id: a.id, kind: a.kind, name: a.name })) }, null, 1)}</pre></details></>
        : engine === 'B' ? <RemotionCode /> : <BrowserExport project={project} />}
    </>
  );
}

function How({ engine }: { engine: Engine }) {
  if (engine === 'A') return (
    <div className="how">
      <p><b>Ідея:</b> таймлайн редагує JSON. Браузер малює прев'ю сам (canvas + приховані &lt;video&gt;), а фінальний файл рендерить сервер однією командою FFmpeg, згенерованою з того ж JSON.</p>
      <ul className="pros">
        <li>FFmpeg — найшвидший і найнадійніший рендер, 20-хв 1080p відео рендериться за хвилини</li>
        <li>Без ліцензій, без headless-браузера, мало пам'яті → дешево масштабувати воркери</li>
        <li>Повний контроль: аудіо-мікс, ducking, LUT, кодеки</li>
      </ul>
      <ul className="cons">
        <li>Два рушії (canvas і FFmpeg) → прев'ю може трохи відрізнятись від результату; кожен ефект пишемо двічі</li>
        <li>Анімовані субтитри / складна графіка у FFmpeg — через ASS-субтитри або пре-рендер PNG; це незручно</li>
      </ul>
    </div>
  );
  if (engine === 'B') return (
    <div className="how">
      <p><b>Ідея:</b> відео — це React-компонент, що отримує JSON проєкту як props. У браузері &lt;Player&gt; програє його покадрово. На сервері <code>@remotion/renderer</code> відкриває цей самий компонент у headless Chrome, знімає кожен кадр і кодує через FFmpeg.</p>
      <ul className="pros">
        <li>Прев'ю = результат, піксель у піксель (один код)</li>
        <li>Анімовані субтитри «слово за словом», переходи, графіка — звичайний React/CSS (див. субтитри тут)</li>
        <li>Готові пакети: captions, transitions, Lambda / Cloud Run для паралельного рендеру</li>
      </ul>
      <ul className="cons">
        <li>Рендер повільніший за чистий FFmpeg (браузер на кожен кадр): 10-хв 1080p — десятки хвилин на одному сервері, лікується паралелізацією</li>
        <li>Ліцензія: безкоштовно для фізосіб і компаній до 3 людей; для SaaS-компанії більше — платна Company License</li>
        <li>Важчі воркери (Chrome + ~1–2 ГБ RAM)</li>
      </ul>
    </div>
  );
  return (
    <div className="how">
      <p><b>Ідея:</b> той самий canvas-рушій, що в A, але фінальний MP4 кодується прямо в браузері через WebCodecs (бібліотека Mediabunny): декодуємо кадри джерел → малюємо → кодуємо H.264 → MP4.</p>
      <ul className="pros">
        <li>Нуль серверних витрат на рендер, миттєвий старт</li>
        <li>Прев'ю = результат (один і той самий drawFrame)</li>
        <li>Відмінно для Shorts 15–60 с</li>
      </ul>
      <ul className="cons">
        <li>Залежить від пристрою користувача; довгі 16:9 відео — повільно і ризиковано (вкладку не закрити)</li>
        <li>Автопаблішинг / пакетна генерація без участі людини неможливі — потрібен браузер</li>
        <li>Аудіо-мікс і субтитри треба писати самим</li>
      </ul>
      <p className="muted">Вкладка «Експорт» — справжній рендер цього таймлайну в MP4.</p>
    </div>
  );
}

function RemotionCode() {
  return (
    <>
      <p className="muted">Скорочено з RemotionPreview.tsx. Цей самий компонент використовується і в Player, і на сервері.</p>
      <pre>{`// браузер — прев'ю
<Player component={VideoComposition}
  inputProps={{ project }}
  durationInFrames={dur * 30} fps={30}
  compositionWidth={1080} compositionHeight={1920} />

// компонент — кадр як функція від часу
const VideoComposition = ({ project }) => (
  <AbsoluteFill>
    {mediaClips.map(c => (
      <Sequence from={c.start*fps} durationInFrames={c.duration*fps}>
        {isImage ? <KenBurns src={url}/>
                 : <Video src={url} trimBefore={c.in*fps}/>}
      </Sequence>))}
    {textClips.map(c => (
      <Sequence ...><WordByWordCaption text={c.text}/></Sequence>))}
  </AbsoluteFill>);

// сервер — воркер черги рендеру
const bundled = await bundle({ entryPoint: 'remotion/index.ts' });
const comp = await selectComposition({ serveUrl: bundled,
  id: 'Main', inputProps: { project } });
await renderMedia({ composition: comp, serveUrl: bundled,
  codec: 'h264', outputLocation: 'out.mp4',
  inputProps: { project }, concurrency: 8,
  onProgress: ({ progress }) => job.report(progress) });`}</pre>
    </>
  );
}

function BrowserExport({ project }: { project: Project }) {
  const [progress, setProgress] = useState<number | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [info, setInfo] = useState('');
  const [scale, setScale] = useState(0.5);
  const run = async () => {
    setUrl(null);
    setProgress(0);
    const t0 = performance.now();
    try {
      const blob = await exportInBrowser(project, scale, setProgress);
      const secs = (performance.now() - t0) / 1000;
      setInfo(`${(blob.size / 1e6).toFixed(1)} МБ, рендер ${secs.toFixed(1)} с для ${projectDuration(project).toFixed(1)} с відео (${(projectDuration(project) / secs).toFixed(1)}× реального часу)`);
      setUrl(URL.createObjectURL(blob));
    } catch (e) {
      setInfo('Помилка: ' + (e as Error).message);
    }
    setProgress(null);
  };
  return (
    <div className="how">
      <label>Роздільність:{' '}
        <select value={scale} onChange={(e) => setScale(+e.target.value)}>
          <option value={0.5}>{project.width / 2}×{project.height / 2}</option>
          <option value={1}>{project.width}×{project.height}</option>
        </select>
      </label>
      <p><button className="big" disabled={progress !== null} onClick={run}>
        {progress !== null ? `Рендер… ${Math.round(progress * 100)}%` : '⬇ Відрендерити MP4 у браузері'}
      </button></p>
      {info && <p className="muted">{info}</p>}
      {url && <><video src={url} controls className="result" /><a href={url} download="demo.mp4">Завантажити demo.mp4</a></>}
    </div>
  );
}
