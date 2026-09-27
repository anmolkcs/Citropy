import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useI18n } from "../lib/i18n.ts";

const clock = (seconds: number) => {
  const total = Number.isFinite(seconds) ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
};

export function VideoPlayer({ src, name, style, onSize }: { src: string; name: string; style?: CSSProperties; onSize?: (width: number, height: number) => void }) {
  const t = useI18n();
  const player = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scrubbing = useRef<{ resume: boolean }>(undefined);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [time, setTime] = useState(0);
  const [pointed, setPointed] = useState<number>();
  const [duration, setDuration] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [active, setActive] = useState(true);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === player.current);
    document.addEventListener("fullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      clearTimeout(idle.current);
    };
  }, []);
  useEffect(() => {
    const element = player.current;
    if (!element) return;
    let intersecting = false;
    const update = () => setVisible(!document.hidden && (intersecting || document.fullscreenElement === element));
    const observer = new IntersectionObserver((entries) => {
      intersecting = entries.at(-1)?.isIntersecting ?? false;
      update();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    document.addEventListener("fullscreenchange", update);
    update();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      document.removeEventListener("fullscreenchange", update);
    };
  }, [error]);
  useEffect(() => {
    const element = video.current;
    if (!visible || !element) return;
    setTime(element.currentTime);
    if (!playing) return;
    let frame = requestAnimationFrame(function follow() {
      setTime(element.currentTime);
      frame = requestAnimationFrame(follow);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, visible, error]);
  const startScrub = () => {
    const element = video.current!;
    scrubbing.current = { resume: !element.paused };
    element.pause();
  };
  const endScrub = () => {
    if (scrubbing.current?.resume) void video.current!.play();
    scrubbing.current = undefined;
  };
  const wake = () => {
    setActive(true);
    clearTimeout(idle.current);
    idle.current = setTimeout(() => setActive(false), 2000);
  };
  const toggle = () => {
    const element = video.current!;
    if (element.paused || element.ended) void element.play();
    else element.pause();
  };
  const seek = (seconds: number) => {
    const element = video.current!;
    element.currentTime = Math.max(0, Math.min(element.duration || 0, seconds));
  };
  const toggleMuted = () => {
    const element = video.current!;
    element.muted = !element.muted;
    if (!element.muted && element.volume === 0) element.volume = 1;
  };
  const changeVolume = (value: number) => {
    const element = video.current!;
    element.volume = value;
    element.muted = value === 0;
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void player.current!.requestFullscreen();
  };
  if (error) return <p className="video-player-error" role="alert">{t("Unable to play this video.")}</p>;
  return (
    <div
      ref={player}
      className="video-player"
      style={style}
      tabIndex={0}
      role="group"
      aria-label={name}
      data-controls={!playing || active || undefined}
      onPointerMove={wake}
      onPointerLeave={() => setActive(false)}
      onFocus={wake}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const element = video.current!;
        const actions: Record<string, () => void> = {
          " ": toggle,
          k: toggle,
          ArrowLeft: () => seek(element.currentTime - 5),
          ArrowRight: () => seek(element.currentTime + 5),
          m: toggleMuted,
          f: toggleFullscreen,
        };
        const action = actions[event.key];
        if (!action || (event.target instanceof HTMLInputElement && event.key.startsWith("Arrow")) || (event.target instanceof HTMLButtonElement && event.key === " ")) return;
        event.preventDefault();
        action();
        wake();
      }}
    >
      <video
        ref={video}
        src={src}
        preload="metadata"
        playsInline
        onClick={toggle}
        onPlay={() => { setPlaying(true); wake(); }}
        onPause={() => { if (!scrubbing.current) setPlaying(false); }}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => { if (visible) setTime(event.currentTarget.currentTime); }}
        onLoadedMetadata={(event) => {
          setDuration(event.currentTarget.duration);
          onSize?.(event.currentTarget.videoWidth, event.currentTarget.videoHeight);
        }}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onVolumeChange={(event) => {
          setMuted(event.currentTarget.muted);
          setVolume(event.currentTarget.volume);
        }}
        onError={() => setError(true)}
      />
      {!playing && (
        <button className="video-player-start" type="button" aria-label={t("Play")} onClick={toggle}>
          <Play size={24} fill="currentColor" />
        </button>
      )}
      <div className="video-player-controls">
        <div className="video-player-seek-wrap">
          {pointed !== undefined && <span className="video-player-pointed" style={{ left: `clamp(24px, ${pointed * 100}%, calc(100% - 24px))` }}>{clock(pointed * duration)}</span>}
          <input
            className="range video-player-seek"
            type="range"
            aria-label={t("Seek")}
            min={0}
            max={duration || 0}
            step="any"
            value={Math.min(time, duration || 0)}
            style={{ "--fill": `${duration ? (time / duration) * 100 : 0}%` } as CSSProperties}
            onPointerDown={startScrub}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
            onPointerMove={(event) => {
              if (event.pointerType === "touch" || !duration) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              setPointed(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)));
            }}
            onPointerLeave={() => setPointed(undefined)}
            onChange={(event) => {
              setTime(Number(event.target.value));
              seek(Number(event.target.value));
            }}
          />
        </div>
        <div className="video-player-bar">
          <button className="icon-btn" type="button" aria-label={t(playing ? "Pause" : "Play")} title={t(playing ? "Pause" : "Play")} onClick={toggle}>
            {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
          </button>
          <div className="video-player-volume">
            <div className="video-player-volume-popup">
              <input
                className="range"
                type="range"
                aria-label={t("Volume")}
                min={0}
                max={1}
                step="any"
                value={muted ? 0 : volume}
                style={{ "--fill": `${muted ? 0 : volume * 100}%` } as CSSProperties}
                onChange={(event) => changeVolume(Number(event.target.value))}
              />
            </div>
            <button className="icon-btn" type="button" aria-label={t(muted ? "Unmute" : "Mute")} title={t(muted ? "Unmute" : "Mute")} onClick={toggleMuted}>
              {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
            </button>
          </div>
          <span className="video-player-time">{clock(time)} <span>/ {clock(duration)}</span></span>
          <span className="video-player-spacer" />
          <button className="icon-btn" type="button" aria-label={t(fullscreen ? "Exit full screen" : "Full screen")} title={t(fullscreen ? "Exit full screen" : "Full screen")} onClick={toggleFullscreen}>
            {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}
