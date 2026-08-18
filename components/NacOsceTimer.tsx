"use client";

import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  Bell,
  CheckCircle2,
  Download,
  Moon,
  Minus,
  Pin,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Sun,
  X,
  Volume2,
  VolumeX
} from "lucide-react";

type TimerMode = "practice" | "exam";
type CaseType = "with-questions" | "counselling";
type Theme = "light" | "dark";
type TimerPhase = "reading" | "encounter" | "questions" | "station-complete" | "complete";
type AlarmType = "reading-end" | "eight-minute" | "counselling-warning" | "station-end";
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
type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
type MiniPosition = { x: number; y: number };

const READING_SECONDS = 2 * 60;
const EIGHT_MINUTE_SECONDS = 8 * 60;
const FULL_ENCOUNTER_SECONDS = 11 * 60;
const QUESTIONS_SECONDS = 3 * 60;
const COUNSELLING_WARNING_REMAINING_SECONDS = 3 * 60;
const EXAM_STATIONS = 12;
const WARNING_SECONDS = 30;
const RING_RADIUS = 44;
const RING_STROKE_WIDTH = 4.5;
const ALARM_AUDIO_SRC = "alarm.m4a";
const WINDOWS_RELEASES_URL = "https://github.com/nacosceapp/timer/releases/latest";
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
  return caseType === "with-questions" ? EIGHT_MINUTE_SECONDS : FULL_ENCOUNTER_SECONDS;
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

function getAlarmAudioSrc() {
  return new URL(ALARM_AUDIO_SRC, document.baseURI).toString();
}

function getAlarmAudio() {
  if (typeof Audio === "undefined") {
    return null;
  }

  if (!sharedAlarmAudio) {
    sharedAlarmAudio = new Audio(getAlarmAudioSrc());
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

  sharedAlarmBufferPromise = fetch(getAlarmAudioSrc())
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
    .catch(() => {
      // Allow a later user gesture to retry after a transient load failure.
      sharedAlarmBufferPromise = null;
      return null;
    });

  return sharedAlarmBufferPromise;
}

function unlockAudio(primeAudioElement = true) {
  const context = getAudioContext();
  const audio = getAlarmAudio();

  if (context) {
    void context.resume().catch(() => undefined);
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
        audio.volume = sharedVolume;
      }, 120);
    })
    .catch(() => {
      // Keep the element locked so a later user gesture can retry playback.
      sharedAlarmUnlocked = false;
      audio.volume = sharedVolume;
    });
}

function startAlarmBuffer(buffer: AudioBuffer) {
  const context = getAudioContext();
  if (!context) {
    return;
  }

  const start = () => {
    const source = context.createBufferSource();
    if (!sharedAudioGain) {
      sharedAudioGain = context.createGain();
      sharedAudioGain.connect(context.destination);
    }
    sharedAudioGain.gain.value = sharedVolume;
    source.buffer = buffer;
    source.connect(sharedAudioGain);
    source.start(context.currentTime + 0.01);
  };

  // Ensure context is running before starting the source, especially on iOS.
  if (context.state === "suspended") {
    void context.resume().then(start).catch(() => undefined);
    return;
  }

  start();
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

  if (type === "eight-minute" || type === "counselling-warning") {
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
  if (caseType === "with-questions") {
    return "8 min encounter, 3 min questions";
  }

  return "11 min counselling, warning at 8 min";
}

export function NacOsceTimer() {
  const [mode, setMode] = useState<TimerMode>("practice");
  const [caseType, setCaseType] = useState<CaseType>("with-questions");
  const [theme, setTheme] = useState<Theme>("light");
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const [isCompactWindow, setIsCompactWindow] = useState(false);
  const [isDesktopApp, setIsDesktopApp] = useState(false);
  const fullWindowBoundsRef = useRef<WindowBounds | null>(null);
  const miniatureDragTimerRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<TimerPhase>("reading");
  const [secondsRemaining, setSecondsRemaining] = useState(getInitialPhaseSeconds);
  const [stationIndex, setStationIndex] = useState(1);
  const [isRunning, setIsRunning] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [seekElapsedSeconds, setSeekElapsedSeconds] = useState<number | null>(null);
  const phaseEndsAtRef = useRef<number | null>(null);
  const counsellingWarningTriggeredRef = useRef(false);

  useEffect(() => {
    setIsDesktopApp(isTauri());

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


  const isCounsellingWarning = caseType === "counselling"
    && phase === "encounter"
    && displaySecondsRemaining <= COUNSELLING_WARNING_REMAINING_SECONDS;
  const isWarning = canSeek && (displaySecondsRemaining <= WARNING_SECONDS || isCounsellingWarning);

  // Compact phase emoji and strings for browser tab title
  const phaseIcon     = phase === "reading" ? "📖" : phase === "encounter" ? (caseType === "counselling" ? "🗣️" : "🩺") : phase === "questions" ? "💬" : "";
  const stationSuffix = stationCount > 1 ? ` ${stationIndex}/${stationCount}` : "";
  const statusIcon    = isWarning ? "⚠️" : isRunning ? "⏱" : "⏸";
  const tabTime       = formatTime(displaySecondsRemaining);
  const tabTitle      = `${statusIcon} ${tabTime} ${phaseIcon}${stationSuffix}`;

  // Ref: track whether component is still mounted so cleanup only resets title on unmount,
  // not on every 500ms tick re-run (which causes the visible "NAC OSCE Timer" flash)
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Update the tab title on every timer tick while leaving the favicon intact.
  useEffect(() => {
    const appName = "NAC OSCE Timer";
    const isIdle  = !isRunning && phase === "reading" && secondsRemaining === READING_SECONDS;

    if (isIdle || phase === "complete" || phase === "station-complete") {
      document.title =
        phase === "complete"         ? "✅ Exam Complete" :
        phase === "station-complete" ? "✅ Station Complete" :
        appName;
    } else {
      document.title = tabTitle;
    }

    // Only restore on unmount — NOT on every re-run, which would flash "NAC OSCE Timer"
    return () => {
      if (!isMountedRef.current) {
        document.title = appName;
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

    if (phase === "encounter" && caseType === "counselling") {
      return "Warning alarm at 8:00 counselling time";
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
  const toggleAlwaysOnTop = useCallback(async () => {
    if (!isDesktopApp) {
      return;
    }

    const next = !isAlwaysOnTop;
    await invoke("set_always_on_top", { enabled: next });
    setIsAlwaysOnTop(next);
  }, [isAlwaysOnTop, isDesktopApp]);
  const toggleCompactWindow = useCallback(async () => {
    if (!isDesktopApp) {
      return;
    }

    const next = !isCompactWindow;
    if (next) {
      setIsCompactWindow(true);

      try {
        const bounds = await invoke<WindowBounds>("get_window_bounds");
        fullWindowBoundsRef.current = bounds;
        // Read this before compacting: resizing raises a Windows move event.
        const savedPosition = await invoke<MiniPosition | null>("load_mini_position").catch(() => null);
        await invoke("set_compact_window", { enabled: true });
        if (savedPosition) {
          await invoke("set_window_position", savedPosition).catch(() => undefined);
        }
      } catch {
        // Keep the miniature UI active even if optional native positioning fails.
      }
    } else {
      setIsCompactWindow(false);
      const fullWindowBounds = fullWindowBoundsRef.current;
      try {
        // Stop miniature-position tracking before the full window moves back.
        await invoke("set_compact_window", { enabled: false });
        if (fullWindowBounds) {
          await invoke("restore_window_bounds", { bounds: fullWindowBounds });
        }
      } catch {
        // The expanded UI remains available even if a native position restore fails.
      }
    }
  }, [isCompactWindow, isDesktopApp]);

  const clearWindowDragTimer = useCallback(() => {
    if (miniatureDragTimerRef.current !== null) {
      window.clearTimeout(miniatureDragTimerRef.current);
      miniatureDragTimerRef.current = null;
    }
  }, []);

  const beginWindowDrag = useCallback((event: PointerEvent<HTMLElement>, allowInteractive = false) => {
    if (event.button !== 0 || !isDesktopApp) {
      return;
    }

    const target = event.target as HTMLElement;
    if (!allowInteractive && target.closest("button, input, select, textarea, a, label, [data-no-window-drag]")) {
      return;
    }

    clearWindowDragTimer();
    miniatureDragTimerRef.current = window.setTimeout(() => {
      miniatureDragTimerRef.current = null;
      void invoke("start_dragging");
    }, 180);
  }, [clearWindowDragTimer, isDesktopApp]);

  useEffect(() => {
    if (!isDesktopApp || !isCompactWindow) {
      return;
    }

    return undefined;
  }, [isCompactWindow, isDesktopApp]);
  const playTimerAlarm = useCallback((type: AlarmType) => playAlarm(type, isMuted), [isMuted]);
  const resetTimer = useCallback(
    (nextMode = mode, nextCaseType = caseType) => {
      phaseEndsAtRef.current = null;
      setMode(nextMode);
      setCaseType(nextCaseType);
      setPhase("reading");
      setSecondsRemaining(READING_SECONDS);
      counsellingWarningTriggeredRef.current = false;
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
    counsellingWarningTriggeredRef.current = false;
    setSeekElapsedSeconds(null);
  }, [autoAdvance, playTimerAlarm, stationCount, stationIndex]);

  const moveToNextPhase = useCallback(() => {
    phaseEndsAtRef.current = null;

    if (phase === "reading") {
      playTimerAlarm("reading-end");
      setPhase("encounter");
      setSecondsRemaining(getEncounterSeconds(caseType));
      counsellingWarningTriggeredRef.current = false;
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
      counsellingWarningTriggeredRef.current = false;
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
        if (
          caseType === "counselling"
          && phase === "encounter"
          && remainingMs <= COUNSELLING_WARNING_REMAINING_SECONDS * 1000
          && !counsellingWarningTriggeredRef.current
        ) {
          counsellingWarningTriggeredRef.current = true;
          playTimerAlarm("counselling-warning");
        }
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
        if (nextPhase === "reading" && advance.phase === "encounter") {
          counsellingWarningTriggeredRef.current = false;
        }
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
    <main className={`${isCompactWindow ? "h-screen overflow-hidden" : "min-h-screen overflow-x-hidden"} bg-[var(--app-bg)] text-[var(--text)]`}>
      <div
        className={isCompactWindow ? "flex h-screen w-full flex-col" : "relative mx-4 flex min-h-screen flex-col py-4 sm:mx-auto sm:w-full sm:max-w-5xl sm:px-6 lg:px-8"}
        onPointerDownCapture={isCompactWindow ? undefined : (event) => beginWindowDrag(event)}
        onPointerUpCapture={isCompactWindow ? undefined : clearWindowDragTimer}
        onPointerCancelCapture={isCompactWindow ? undefined : clearWindowDragTimer}
      >
        {!isCompactWindow && <header className={isDesktopApp ? "flex flex-col gap-3 py-2" : "flex items-center justify-between gap-3 py-2"}>
          <div
            className={isDesktopApp ? "flex min-w-0 items-center justify-between gap-3 cursor-move select-none" : "min-w-0"}
          >
            <h1 className={isDesktopApp ? "truncate text-2xl font-semibold sm:text-3xl gradient-text" : "text-2xl font-semibold sm:text-3xl gradient-text"}>NAC OSCE Timer</h1>
            {isDesktopApp && (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void invoke("minimize_window")}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-clinical-line bg-[var(--surface)] text-[var(--text)] shadow-sm hover:bg-[var(--surface-muted)]"
                  aria-label="Minimize window"
                  title="Minimize"
                >
                  <Minus size={19} />
                </button>
                <button
                  type="button"
                  onClick={() => void invoke("close_window")}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-clinical-line bg-[var(--surface)] text-[var(--text)] shadow-sm hover:bg-red-50 hover:text-red-700"
                  aria-label="Close window"
                  title="Close"
                >
                  <X size={19} />
                </button>
              </div>
            )}
          </div>
          <div className={isDesktopApp ? "flex w-full min-w-0 flex-wrap items-center gap-2" : "flex shrink-0 items-center gap-2"}>
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
            {isDesktopApp && <>
            <button
              type="button"
              onClick={toggleAlwaysOnTop}
              disabled={!isDesktopApp}
              className={`inline-flex h-11 w-11 items-center justify-center rounded-md border border-clinical-line bg-[var(--surface)] text-[var(--text)] shadow-sm hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-40 ${isAlwaysOnTop ? "bg-clinical-mist text-clinical-teal" : ""}`}
              aria-label={isAlwaysOnTop ? "Disable always on top" : "Keep window on top"}
              title={isAlwaysOnTop ? "Disable always on top" : "Keep window on top"}
              aria-pressed={isAlwaysOnTop}
            >
              <Pin size={19} />
            </button>
            <button
              type="button"
              onClick={toggleCompactWindow}
              disabled={!isDesktopApp}
              className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-clinical-line bg-[var(--surface)] text-[var(--text)] shadow-sm hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={isCompactWindow ? "Use full window" : "Use compact window"}
              title={isCompactWindow ? "Use full window" : "Use compact window"}
              aria-pressed={isCompactWindow}
            >
              <Minimize2 size={19} />
            </button>
            </>}
          </div>
        </header>}

        {isCompactWindow ? (
          <section
            className="flex w-full flex-1 cursor-move select-none flex-col items-center justify-center overflow-hidden rounded-lg border border-clinical-line bg-[var(--surface)] px-1 py-0 shadow-panel"
            data-tauri-drag-region="true"
            onDoubleClickCapture={() => void toggleCompactWindow()}
            onPointerDownCapture={(event) => beginWindowDrag(event, true)}
            onPointerUpCapture={clearWindowDragTimer}
            onPointerCancelCapture={clearWindowDragTimer}
            title="Double-click to restore the full timer"
          >
            <p className={`pointer-events-none font-mono text-4xl font-semibold leading-none ${isWarning ? "text-red-700" : "text-clinical-navy"}`}>
              {formatTime(displaySecondsRemaining)}
            </p>
            <p className={`pointer-events-none mt-0.5 max-w-full truncate text-center text-[10px] font-semibold leading-tight ${isWarning ? "text-red-700" : "text-[var(--text-soft)]"}`}>
              {getPhaseLabel(phase)}
            </p>
          </section>
        ) : (
          <>
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
                {(["with-questions", "counselling"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => resetTimer(mode, option)}
                    className={`flex h-20 flex-col justify-center rounded-md border px-3 py-2 text-left text-sm font-semibold ${caseType === option
                      ? "border-clinical-teal bg-clinical-mist text-clinical-navy"
                      : "border-clinical-line bg-[var(--surface)] text-[var(--text-soft)]"
                      }`}
                  >
                    <span className="block">
                      {option === "with-questions" ? "With oral questions" : "Counselling"}
                    </span>
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
        {!isDesktopApp && (
          <section className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-clinical-line bg-[var(--surface)] p-4 shadow-panel sm:p-5">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-clinical-navy">Use the Windows desktop app</p>
              <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                Optional offline miniature timer with always-on-top support.
              </p>
            </div>
            <a
              href={WINDOWS_RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-clinical-blue px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              <Download size={17} />
              Download for Windows
            </a>
          </section>
        )}
          </>
        )}
      </div>
    </main>
  );
}
