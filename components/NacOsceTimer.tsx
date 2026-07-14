"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  CheckCircle2,
  Moon,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Sun,
  Volume2,
  VolumeX
} from "lucide-react";

type TimerMode = "practice" | "exam";
type CaseType = "with-questions" | "without-questions";
type Theme = "light" | "dark";
type TimerPhase = "reading" | "encounter" | "questions" | "station-complete" | "complete";
type AlarmType = "reading-end" | "eight-minute" | "station-end";
type WindowWithAudioFallback = Window & {
  webkitAudioContext?: typeof AudioContext;
};
type TimedPhaseAdvance = {
  alarm: AlarmType;
  phase: TimerPhase;
  secondsRemaining: number;
  stationIndex: number;
  isRunning: boolean;
};

const READING_SECONDS = 2 * 60;
const EIGHT_MINUTE_SECONDS = 8 * 60;
const FULL_ENCOUNTER_SECONDS = 11 * 60;
const QUESTIONS_SECONDS = 3 * 60;
const EXAM_STATIONS = 12;
const WARNING_SECONDS = 30;
const RING_RADIUS = 44;
const RING_STROKE_WIDTH = 4.5;
const ALARM_AUDIO_SRC = "alarm.m4a";
let sharedAudioContext: AudioContext | null = null;
let sharedAlarmAudio: HTMLAudioElement | null = null;
let sharedAlarmBuffer: AudioBuffer | null = null;
let sharedAlarmBufferPromise: Promise<AudioBuffer | null> | null = null;
let sharedAlarmUnlocked = false;
let sharedAudioGain: GainNode | null = null;
let sharedVolume = 1;

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function getStationCount(mode: TimerMode) {
  return mode === "exam" ? EXAM_STATIONS : 1;
}

function getInitialPhaseSeconds() {
  return READING_SECONDS;
}

function getEncounterSeconds(caseType: CaseType) {
  return caseType === "without-questions" ? FULL_ENCOUNTER_SECONDS : EIGHT_MINUTE_SECONDS;
}

function getPhaseLabel(phase: TimerPhase) {
  if (phase === "reading") {
    return "Reading";
  }

  if (phase === "encounter") {
    return "Encounter";
  }

  if (phase === "questions") {
    return "Post-encounter questions";
  }

  if (phase === "station-complete") {
    return "Station complete";
  }

  return "Exam complete";
}

function getPhaseDuration(phase: TimerPhase, caseType: CaseType) {
  if (phase === "reading") {
    return READING_SECONDS;
  }

  if (phase === "encounter") {
    return getEncounterSeconds(caseType);
  }

  if (phase === "questions") {
    return QUESTIONS_SECONDS;
  }

  return 1;
}

function getTimedPhaseAdvance(
  phase: TimerPhase,
  caseType: CaseType,
  stationIndex: number,
  stationCount: number,
  autoAdvance: boolean
): TimedPhaseAdvance | null {
  if (phase === "reading") {
    return {
      alarm: "reading-end",
      phase: "encounter",
      secondsRemaining: getEncounterSeconds(caseType),
      stationIndex,
      isRunning: true
    };
  }

  if (phase === "encounter" && caseType === "with-questions") {
    return {
      alarm: "eight-minute",
      phase: "questions",
      secondsRemaining: QUESTIONS_SECONDS,
      stationIndex,
      isRunning: true
    };
  }

  if (phase === "encounter" || phase === "questions") {
    if (stationIndex >= stationCount) {
      return {
        alarm: "station-end",
        phase: "complete",
        secondsRemaining: 0,
        stationIndex,
        isRunning: false
      };
    }

    if (!autoAdvance) {
      return {
        alarm: "station-end",
        phase: "station-complete",
        secondsRemaining: 0,
        stationIndex,
        isRunning: false
      };
    }

    return {
      alarm: "station-end",
      phase: "reading",
      secondsRemaining: READING_SECONDS,
      stationIndex: stationIndex + 1,
      isRunning: true
    };
  }

  return null;
}

function getAudioContext() {
  const AudioContextConstructor =
    window.AudioContext ?? (window as WindowWithAudioFallback).webkitAudioContext;
  if (!AudioContextConstructor) {
    return null;
  }

  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    sharedAudioContext = new AudioContextConstructor();
  }

  return sharedAudioContext;
}

function getAlarmAudio() {
  if (typeof Audio === "undefined") {
    return null;
  }

  if (!sharedAlarmAudio) {
    sharedAlarmAudio = new Audio(ALARM_AUDIO_SRC);
    sharedAlarmAudio.preload = "auto";
    sharedAlarmAudio.volume = sharedVolume;
    sharedAlarmAudio.setAttribute("playsinline", "true");
    sharedAlarmAudio.setAttribute("webkit-playsinline", "true");
  }

  return sharedAlarmAudio;
}

function loadAlarmBuffer() {
  const context = getAudioContext();
  if (!context) {
    return null;
  }

  if (sharedAlarmBuffer) {
    return Promise.resolve(sharedAlarmBuffer);
  }

  if (sharedAlarmBufferPromise) {
    return sharedAlarmBufferPromise;
  }

  sharedAlarmBufferPromise = fetch(ALARM_AUDIO_SRC)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Unable to load alarm audio: ${response.status}`);
      }

      return response.arrayBuffer();
    })
    .then((audioData) => context.decodeAudioData(audioData))
    .then((buffer) => {
      sharedAlarmBuffer = buffer;
      return buffer;
    })
    .catch(() => null);

  return sharedAlarmBufferPromise;
}

function unlockAudio(primeAudioElement = true) {
  const context = getAudioContext();
  const audio = getAlarmAudio();

  if (context) {
    void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0.0001;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.01);
    void loadAlarmBuffer();
  }

  if (!primeAudioElement || !audio || sharedAlarmUnlocked) {
    return;
  }

  audio.load();
  audio.currentTime = 0;
  audio.volume = 0.04;
  const playPromise = audio.play();
  void playPromise
    .then(() => {
      sharedAlarmUnlocked = true;
      window.setTimeout(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = 1;
      }, 120);
    })
    .catch(() => {
      // On iOS Safari, the initial play might fail due to policy restrictions
      // Mark as unlocked anyway since the audio context is ready
      sharedAlarmUnlocked = true;
      audio.volume = 1;
    });
}

function startAlarmBuffer(buffer: AudioBuffer) {
  const context = getAudioContext();
  if (!context) {
    return;
  }

  // Ensure context is running (especially important for iOS Safari)
  if (context.state === "suspended") {
    void context.resume();
  }

  const source = context.createBufferSource();
  if (!sharedAudioGain) {
    sharedAudioGain = context.createGain();
    sharedAudioGain.connect(context.destination);
  }
  sharedAudioGain.gain.value = sharedVolume;
  source.buffer = buffer;
  source.connect(sharedAudioGain);
  source.start(context.currentTime + 0.01);
}

function playPreparedAlarm() {
  if (!sharedAlarmBuffer) {
    return false;
  }

  startAlarmBuffer(sharedAlarmBuffer);
  return true;
}

function playAlarmBuffer(onFallback: () => void) {
  const bufferPromise = loadAlarmBuffer();
  if (!bufferPromise) {
    onFallback();
    return;
  }

  void bufferPromise.then((buffer) => {
    if (!buffer) {
      onFallback();
      return;
    }

    startAlarmBuffer(buffer);
  });
}

function playAlarmElement() {
  const context = getAudioContext();
  const audio = getAlarmAudio();
  if (!audio) {
    return;
  }

  // Ensure audio context is resumed on iOS Safari
  if (context && context.state === "suspended") {
    void context.resume();
  }

  audio.pause();
  audio.currentTime = 0;
  audio.volume = sharedVolume;
  const playPromise = audio.play();
  void playPromise
    .then(() => {
      sharedAlarmUnlocked = true;
    })
    .catch(() => {
      if (!playPreparedAlarm()) {
        playAlarmBuffer(() => undefined);
      }
    });
}

function playAlarm(type: AlarmType, isMuted = false) {
  if (!isMuted) {
    playAlarmElement();
  }

  if (type === "reading-end") {
    navigator.vibrate?.([160, 80, 160]);
    return;
  }

  if (type === "eight-minute") {
    navigator.vibrate?.([140, 70, 140]);
    return;
  }

  navigator.vibrate?.([240, 100, 240, 100, 340]);
}
function playTestAlarm() {
  // On iOS Safari, HTMLAudioElement is more reliable for autoplay
  if (isIOS()) {
    playAlarmElement();
    return;
  }

  const bufferPromise = loadAlarmBuffer();
  if (!bufferPromise) {
    playAlarmElement();
    return;
  }

  void bufferPromise.then((buffer) => {
    if (!buffer) {
      playAlarmElement();
      return;
    }
    startAlarmBuffer(buffer);
  });
}
function setAudioVolume(volume: number) {
  const normalizedVolume = Math.max(0, Math.min(1, volume));
  // Use logarithmic scale for better low-volume granularity
  const audioVolume = Math.pow(normalizedVolume, 2.5);
  sharedVolume = audioVolume;
  if (sharedAudioGain) {
    sharedAudioGain.gain.value = audioVolume;
  }
  const audio = sharedAlarmAudio;
  if (audio) {
    audio.volume = audioVolume;
  }
}

function getModeDescription(mode: TimerMode) {
  return mode === "exam" ? "12-station circuit" : "Single station";
}

function getCaseTypeDescription(caseType: CaseType) {
  return caseType === "with-questions"
    ? "8 min encounter, 3 min questions"
    : "11 min encounter";
}

export function NacOsceTimer() {
  const [mode, setMode] = useState<TimerMode>("practice");
  const [caseType, setCaseType] = useState<CaseType>("with-questions");
  const [theme, setTheme] = useState<Theme>("light");
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const [phase, setPhase] = useState<TimerPhase>("reading");
  const [secondsRemaining, setSecondsRemaining] = useState(getInitialPhaseSeconds);
  const [stationIndex, setStationIndex] = useState(1);
  const [isRunning, setIsRunning] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [seekElapsedSeconds, setSeekElapsedSeconds] = useState<number | null>(null);
  const phaseEndsAtRef = useRef<number | null>(null);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("nac-osce-theme");
    if (savedTheme === "light" || savedTheme === "dark") {
      setTheme(savedTheme);
    } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      setTheme("dark");
    }

    setIsMuted(window.localStorage.getItem("nac-osce-muted") === "true");

    const savedVolume = window.localStorage.getItem("nac-osce-volume");
    if (savedVolume !== null) {
      const vol = parseFloat(savedVolume);
      if (!isNaN(vol)) {
        setVolumeState(vol);
        setAudioVolume(vol);
      }
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("nac-osce-theme", theme);
  }, [theme]);

  const stationCount = getStationCount(mode);
  const phaseDuration = getPhaseDuration(phase, caseType);
  const elapsedSeconds = phaseDuration - secondsRemaining;
  const sliderElapsedSeconds = seekElapsedSeconds ?? elapsedSeconds;
  const canSeek = phase !== "complete" && phase !== "station-complete";
  const displaySecondsRemaining = canSeek ? phaseDuration - sliderElapsedSeconds : 0;


  const isWarning = canSeek && displaySecondsRemaining <= WARNING_SECONDS;

  // Compact phase emoji and strings for browser tab title
  const phaseIcon     = phase === "reading" ? "📖" : phase === "encounter" ? "🩺" : phase === "questions" ? "💬" : "";
  const stationSuffix = stationCount > 1 ? ` ${stationIndex}/${stationCount}` : "";
  const statusIcon    = isWarning ? "⚠️" : isRunning ? "⏱" : "⏸";
  const tabTime       = formatTime(displaySecondsRemaining);
  const tabTitle      = `${statusIcon} ${tabTime} ${phaseIcon}${stationSuffix}`;

  // Ref: store the real Next.js-generated favicon href (captured once at mount)
  const faviconHrefRef = useRef("/icon.png");

  // On mount: snapshot the actual favicon href so we can restore it exactly
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (link?.href) faviconHrefRef.current = link.href;
  }, []);

  // Swap favicon href — never remove the element (Next.js re-inserts removed link tags)
  const BLANK_FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
  function hideFavicon() {
    const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (link && link.href !== BLANK_FAVICON) link.href = BLANK_FAVICON;
  }
  function showFavicon() {
    const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (link) link.href = faviconHrefRef.current;
  }

  // Ref: track whether component is still mounted so cleanup only resets title on unmount,
  // not on every 500ms tick re-run (which causes the visible "NAC OSCE Timer" flash)
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Single effect: update tab title + favicon on every timer tick
  useEffect(() => {
    const appName = "NAC OSCE Timer";
    const isIdle  = !isRunning && phase === "reading" && secondsRemaining === READING_SECONDS;

    if (isIdle || phase === "complete" || phase === "station-complete") {
      showFavicon();
      document.title =
        phase === "complete"         ? "✅ Exam Complete" :
        phase === "station-complete" ? "✅ Station Complete" :
        appName;
    } else {
      // Active timer: blank favicon, set countdown title
      hideFavicon();
      document.title = tabTitle;
    }

    // Only restore on unmount — NOT on every re-run, which would flash "NAC OSCE Timer"
    return () => {
      if (!isMountedRef.current) {
        document.title = appName;
        showFavicon();
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabTitle, isRunning, phase, secondsRemaining]);


  const remainingProgress = useMemo(() => {
    if (!canSeek) {
      return 0;
    }

    return Math.max(0, Math.min(displaySecondsRemaining / phaseDuration, 1));
  }, [canSeek, displaySecondsRemaining, phaseDuration]);
  const ringOffset = 100 - remainingProgress * 100;

  const currentSignal = useMemo(() => {
    if (phase === "reading") {
      return "Next alarm: enter room at 2:00";
    }

    if (phase === "encounter" && caseType === "with-questions") {
      return "Next alarm: 8-minute oral-question signal";
    }

    if (phase === "encounter") {
      return "Next alarm: final 11-minute signal";
    }

    if (phase === "questions") {
      return "Next alarm: final 11-minute signal";
    }

    return "Timer stopped";
  }, [caseType, phase]);

  const toggleMute = useCallback(() => {
    setIsMuted((current) => {
      const next = !current;
      window.localStorage.setItem("nac-osce-muted", String(next));

      if (!next) {
        unlockAudio(false);
      }

      return next;
    });
  }, []);

  const handleVolumeChange = useCallback((newVolume: number) => {
    setVolumeState(newVolume);
    setAudioVolume(newVolume);
    window.localStorage.setItem("nac-osce-volume", String(newVolume));
  }, []);

  const handleVolumeTouchStart = useCallback(() => {
    // On iOS Safari, try to unlock audio on first touch
    if (isIOS() && !isMuted) {
      unlockAudio(false);
    }
  }, [isMuted]);

  const handleVolumeRelease = useCallback(() => {
    if (!isMuted) {
      unlockAudio(false);
      playTestAlarm();
    }
  }, [isMuted]);
  const playTimerAlarm = useCallback((type: AlarmType) => playAlarm(type, isMuted), [isMuted]);
  const resetTimer = useCallback(
    (nextMode = mode, nextCaseType = caseType) => {
      phaseEndsAtRef.current = null;
      setMode(nextMode);
      setCaseType(nextCaseType);
      setPhase("reading");
      setSecondsRemaining(READING_SECONDS);
      setStationIndex(1);
      setIsRunning(false);
      setSeekElapsedSeconds(null);
    },
    [caseType, mode]
  );

  const commitSeek = useCallback(
    (elapsedValue: number) => {
      if (!canSeek) {
        return;
      }

      const nextElapsed = Math.min(Math.max(elapsedValue, 0), phaseDuration);
      phaseEndsAtRef.current = null;
      setSecondsRemaining(phaseDuration - nextElapsed);
    },
    [canSeek, phaseDuration]
  );

  const updateSeekPreview = useCallback(
    (elapsedValue: number) => {
      if (!canSeek) {
        return;
      }

      setSeekElapsedSeconds(Math.min(Math.max(elapsedValue, 0), phaseDuration));
    },
    [canSeek, phaseDuration]
  );

  const finishSeek = useCallback(() => {
    if (seekElapsedSeconds === null) {
      return;
    }

    commitSeek(seekElapsedSeconds);
    setSeekElapsedSeconds(null);
  }, [commitSeek, seekElapsedSeconds]);

  const finishStation = useCallback(() => {
    phaseEndsAtRef.current = null;
    playTimerAlarm("station-end");

    if (stationIndex >= stationCount) {
      setPhase("complete");
      setSecondsRemaining(0);
      setIsRunning(false);
      return;
    }

    if (!autoAdvance) {
      setPhase("station-complete");
      setSecondsRemaining(0);
      setIsRunning(false);
      return;
    }

    setStationIndex((current) => current + 1);
    setPhase("reading");
    setSecondsRemaining(READING_SECONDS);
    setSeekElapsedSeconds(null);
  }, [autoAdvance, playTimerAlarm, stationCount, stationIndex]);

  const moveToNextPhase = useCallback(() => {
    phaseEndsAtRef.current = null;

    if (phase === "reading") {
      playTimerAlarm("reading-end");
      setPhase("encounter");
      setSecondsRemaining(getEncounterSeconds(caseType));
      setSeekElapsedSeconds(null);
      return;
    }

    if (phase === "encounter" && caseType === "with-questions") {
      playTimerAlarm("eight-minute");
      setPhase("questions");
      setSecondsRemaining(QUESTIONS_SECONDS);
      setSeekElapsedSeconds(null);
      return;
    }

    if (phase === "encounter" || phase === "questions") {
      finishStation();
      return;
    }

    if (phase === "station-complete") {
      setStationIndex((current) => Math.min(current + 1, stationCount));
      setPhase("reading");
      setSecondsRemaining(READING_SECONDS);
      setIsRunning(true);
      setSeekElapsedSeconds(null);
    }
  }, [caseType, finishStation, phase, playTimerAlarm, stationCount]);

  const toggleTimer = useCallback(() => {
    if (!isMuted) {
      unlockAudio();
    }

    if (isRunning) {
      const phaseEndsAt = phaseEndsAtRef.current;
      if (phaseEndsAt !== null) {
        setSecondsRemaining(Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000)));
      }

      phaseEndsAtRef.current = null;
      setIsRunning(false);
      return;
    }

    phaseEndsAtRef.current = Date.now() + secondsRemaining * 1000;
    setIsRunning(true);
  }, [isMuted, isRunning, secondsRemaining]);

  const syncTimerToNow = useCallback(
    (now: number) => {
      const phaseEndsAt = phaseEndsAtRef.current;
      if (phaseEndsAt === null) {
        phaseEndsAtRef.current = now + secondsRemaining * 1000;
        return;
      }

      const remainingMs = phaseEndsAt - now;
      if (remainingMs > 0) {
        setSecondsRemaining(Math.ceil(remainingMs / 1000));
        return;
      }

      let overdueMs = Math.abs(remainingMs);
      let nextPhase = phase;
      let nextStationIndex = stationIndex;
      let nextSecondsRemaining = 0;
      let nextIsRunning = false;
      const alarms: AlarmType[] = [];

      while (true) {
        const advance = getTimedPhaseAdvance(
          nextPhase,
          caseType,
          nextStationIndex,
          stationCount,
          autoAdvance
        );

        if (!advance) {
          phaseEndsAtRef.current = null;
          setIsRunning(false);
          return;
        }

        alarms.push(advance.alarm);
        nextPhase = advance.phase;
        nextStationIndex = advance.stationIndex;
        nextSecondsRemaining = advance.secondsRemaining;
        nextIsRunning = advance.isRunning;

        if (!nextIsRunning || nextSecondsRemaining * 1000 > overdueMs) {
          break;
        }

        overdueMs -= nextSecondsRemaining * 1000;
      }

      const latestAlarm = alarms[alarms.length - 1];
      if (latestAlarm) {
        playTimerAlarm(latestAlarm);
      }
      setPhase(nextPhase);
      setStationIndex(nextStationIndex);
      setSeekElapsedSeconds(null);
      setIsRunning(nextIsRunning);

      if (!nextIsRunning) {
        phaseEndsAtRef.current = null;
        setSecondsRemaining(0);
        return;
      }

      const nextRemainingMs = nextSecondsRemaining * 1000 - overdueMs;
      phaseEndsAtRef.current = now + nextRemainingMs;
      setSecondsRemaining(Math.ceil(nextRemainingMs / 1000));
    },
    [autoAdvance, caseType, phase, playTimerAlarm, secondsRemaining, stationCount, stationIndex]
  );

  useEffect(() => {
    if (!isRunning || seekElapsedSeconds !== null || phase === "complete" || phase === "station-complete") {
      phaseEndsAtRef.current = null;
      return;
    }

    syncTimerToNow(Date.now());
    const interval = window.setInterval(() => syncTimerToNow(Date.now()), 500);

    return () => window.clearInterval(interval);
  }, [isRunning, phase, seekElapsedSeconds, syncTimerToNow]);

  return (
    <main className="min-h-screen overflow-x-hidden bg-[var(--app-bg)] text-[var(--text)]">
      <div className="mx-4 flex min-h-screen flex-col py-4 sm:mx-auto sm:w-full sm:max-w-5xl sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-3 py-2">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold sm:text-3xl gradient-text">NAC OSCE Timer</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="inline-flex h-11 items-center gap-0.5 rounded-md border border-clinical-line bg-[var(--surface)] px-2 shadow-sm">
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={(event) => handleVolumeChange(parseFloat(event.target.value))}
                onPointerUp={handleVolumeRelease}
                onMouseUp={handleVolumeRelease}
                onTouchStart={handleVolumeTouchStart}
                onTouchEnd={handleVolumeRelease}
                className="volume-slider w-28"
                aria-label="Volume"
                title="Adjust volume"
              />
              <span className="w-9 text-right text-xs font-semibold text-[var(--text-muted)]">
                {Math.round(volume * 100)}%
              </span>
            </div>
            <button
              type="button"
              onClick={toggleMute}
              className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-clinical-line bg-[var(--surface)] text-[var(--text)] shadow-sm hover:bg-[var(--surface-muted)]"
              aria-label={isMuted ? "Unmute timer sounds" : "Mute timer sounds"}
              title={isMuted ? "Unmute timer sounds" : "Mute timer sounds"}
              aria-pressed={isMuted}
            >
              {isMuted ? <VolumeX size={19} /> : <Volume2 size={19} />}
            </button>
            <button
              type="button"
              onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
              className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-clinical-line bg-[var(--surface)] text-[var(--text)] shadow-sm hover:bg-[var(--surface-muted)]"
              aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
              title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
            >
              {theme === "light" ? <Moon size={19} /> : <Sun size={19} />}
            </button>
          </div>
        </header>

        <section className="mt-4 flex w-full min-w-0 flex-1 flex-col justify-center rounded-lg border border-clinical-line bg-[var(--surface)] p-4 shadow-panel sm:p-6">
          <div>
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Station {stationIndex} of {stationCount}
              </p>
              <p className="mt-2 inline-flex items-center gap-2 rounded-md bg-clinical-mist px-3 py-1 text-sm font-semibold text-clinical-navy">
                {phase === "complete" ? <CheckCircle2 size={16} /> : <Bell size={16} />}
                {getPhaseLabel(phase)}
              </p>
            </div>
          </div>

          <div className="mt-5">
            <div
              className={`relative mx-auto aspect-square w-full max-w-[18rem] rounded-full sm:max-w-[21rem] ${isWarning ? "timer-warning" : ""
                }`}
            >
              <svg
                className="absolute inset-0 block h-full w-full -rotate-90"
                viewBox="0 0 100 100"
                preserveAspectRatio="xMidYMid meet"
                aria-hidden="true"
              >
                <circle
                  cx="50"
                  cy="50"
                  r={RING_RADIUS}
                  fill="none"
                  stroke="var(--surface-muted)"
                  strokeWidth={RING_STROKE_WIDTH}
                />
                <circle
                  cx="50"
                  cy="50"
                  r={RING_RADIUS}
                  fill="none"
                  stroke={isWarning ? "#ef4444" : "var(--clinical-teal)"}
                  strokeWidth={RING_STROKE_WIDTH}
                  strokeLinecap="round"
                  pathLength={100}
                  strokeDasharray={100}
                  strokeDashoffset={ringOffset}
                  className="transition-[stroke] duration-150 ease-out"
                />
              </svg>
              <div
                className={`absolute inset-[24px] flex items-center justify-center rounded-full sm:inset-[28px] ${isWarning ? "bg-[var(--warning-bg)]" : "bg-[var(--timer-bg)]"
                  }`}
              >
                <div className="text-center">
                  <p className={`font-mono text-6xl font-semibold sm:text-7xl ${isWarning ? "text-red-700" : "text-clinical-navy"}`}>
                    {formatTime(displaySecondsRemaining)}
                  </p>
                  <p className="mt-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    {phase === "complete" ? "Done" : isRunning ? "Running" : "Paused"}
                  </p>
                </div>
              </div>
            </div>
            <div className="mt-4">
              <input
                type="range"
                min={0}
                max={phaseDuration}
                step={1}
                value={canSeek ? sliderElapsedSeconds : phaseDuration}
                onPointerDown={() => {
                  if (canSeek) {
                    setSeekElapsedSeconds(elapsedSeconds);
                  }
                }}
                onPointerUp={finishSeek}
                onPointerCancel={finishSeek}
                onBlur={finishSeek}
                onKeyUp={finishSeek}
                onChange={(event) => {
                  const nextElapsed = Number(event.target.value);
                  updateSeekPreview(nextElapsed);
                  commitSeek(nextElapsed);
                }}
                disabled={!canSeek}
                aria-label="Adjust timer position"
                className="time-slider w-full accent-clinical-teal disabled:opacity-50"
              />
              <div className="mt-2 flex items-center justify-between text-xs font-semibold text-[var(--text-muted)]">
                <span>{formatTime(canSeek ? sliderElapsedSeconds : phaseDuration)} elapsed</span>
                <span>{formatTime(displaySecondsRemaining)} remaining</span>
              </div>
            </div>
            <p className="mt-3 text-center text-sm font-semibold text-[var(--text-soft)]">{currentSignal}</p>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={toggleTimer}
              disabled={phase === "complete" || phase === "station-complete"}
              className="inline-flex h-14 w-full items-center justify-center gap-2 rounded-md bg-clinical-blue px-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRunning ? <Pause size={18} /> : <Play size={18} />}
              {isRunning ? "Pause" : "Start"}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!isMuted) {
                  unlockAudio();
                }
                moveToNextPhase();
              }}
              disabled={phase === "complete"}
              className="inline-flex h-14 w-full items-center justify-center gap-2 rounded-md border border-clinical-line bg-[var(--surface)] px-3 text-sm font-semibold text-clinical-navy hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <SkipForward size={18} />
              {phase === "station-complete" ? "Next station" : "Next signal"}
            </button>
            <button
              type="button"
              onClick={() => resetTimer()}
              className="inline-flex h-14 w-full items-center justify-center gap-2 rounded-md border border-clinical-line bg-[var(--surface)] px-3 text-sm font-semibold text-clinical-navy hover:bg-[var(--surface-muted)]"
            >
              <RotateCcw size={18} />
              Reset
            </button>
          </div>
        </section>

        <section className="mt-4 w-full rounded-lg border border-clinical-line bg-[var(--surface)] p-4 shadow-panel sm:p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="text-sm font-semibold text-clinical-navy">Mode</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {(["practice", "exam"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => resetTimer(option, caseType)}
                    className={`flex h-20 flex-col justify-center rounded-md border px-3 py-2 text-left text-sm font-semibold ${mode === option
                      ? "border-clinical-teal bg-clinical-mist text-clinical-navy"
                      : "border-clinical-line bg-[var(--surface)] text-[var(--text-soft)]"
                      }`}
                  >
                    <span className="block capitalize">{option}</span>
                    <span className="mt-1 block text-xs font-medium leading-tight text-[var(--text-muted)]">{getModeDescription(option)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-sm font-semibold text-clinical-navy">Station type</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {(["with-questions", "without-questions"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => resetTimer(mode, option)}
                    className={`flex h-20 flex-col justify-center rounded-md border px-3 py-2 text-left text-sm font-semibold ${caseType === option
                      ? "border-clinical-teal bg-clinical-mist text-clinical-navy"
                      : "border-clinical-line bg-[var(--surface)] text-[var(--text-soft)]"
                      }`}
                  >
                    <span className="block">{option === "with-questions" ? "With oral questions" : "No oral questions"}</span>
                    <span className="mt-1 block text-xs font-medium leading-tight text-[var(--text-muted)]">{getCaseTypeDescription(option)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="mt-4 w-full rounded-lg border border-clinical-line bg-[var(--surface)] p-4 shadow-panel sm:p-5">
          <label className="flex items-center justify-between gap-3 rounded-md border border-clinical-line px-3 py-3">
            <span>
              <span className="block text-sm font-semibold text-[var(--text-soft)]">Auto-advance stations</span>
              <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
                Useful for full 12-station mode.
              </span>
            </span>
            <input
              type="checkbox"
              checked={autoAdvance}
              onChange={(event) => setAutoAdvance(event.target.checked)}
              className="h-5 w-5 shrink-0 accent-clinical-teal"
            />
          </label>
        </section>
      </div>
    </main>
  );
}
