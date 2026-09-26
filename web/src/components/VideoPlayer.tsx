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

export function VideoPlayer({ src, name }: { src: string; name: string }) {
  const t = useI18n();
  const player = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [active, setActive] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === player.current);
    document.addEventListener("fullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      clearTimeout(idle.current);
    };
  }, []);
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
    video.current!.muted = !video.current!.muted;
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
        onDoubleClick={toggleFullscreen}
        onPlay={() => { setPlaying(true); wake(); }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
        onError={() => setError(true)}
      />
      {!playing && (
        <button className="video-player-start" type="button" aria-label={t("Play")} onClick={toggle}>
          <Play size={26} fill="currentColor" />
        </button>
      )}
      <div className="video-player-controls">
        <button className="icon-btn" type="button" aria-label={t(playing ? "Pause" : "Play")} title={t(playing ? "Pause" : "Play")} onClick={toggle}>
          {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
        </button>
        <span className="video-player-time">{clock(time)}</span>
        <input
          className="range"
          type="range"
          aria-label={t("Seek")}
          min={0}
          max={duration || 0}
          step="any"
          value={Math.min(time, duration || 0)}
          style={{ "--fill": `${duration ? (time / duration) * 100 : 0}%` } as CSSProperties}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span className="video-player-time">{clock(duration)}</span>
        <button className="icon-btn" type="button" aria-label={t(muted ? "Unmute" : "Mute")} title={t(muted ? "Unmute" : "Mute")} onClick={toggleMuted}>
          {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
        <button className="icon-btn" type="button" aria-label={t(fullscreen ? "Exit full screen" : "Full screen")} title={t(fullscreen ? "Exit full screen" : "Full screen")} onClick={toggleFullscreen}>
          {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
        </button>
      </div>
    </div>
  );
}
