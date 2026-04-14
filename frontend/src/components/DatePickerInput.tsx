import { useEffect, useRef, useCallback } from "react";
import { t } from "@/i18n";

declare global {
  interface Window {
    DatePicker?: {
      DatePicker: new (wrapper: HTMLElement, options?: any) => any;
    };
  }
}

let scriptLoaded = false;
let scriptPromise: Promise<void> | null = null;
let holidaysCache: Set<string> | null = null;

function loadDatePickerScript(): Promise<void> {
  if (scriptLoaded) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    // Check if already loaded
    if (window.DatePicker) {
      scriptLoaded = true;
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "/datepicker.js";
    script.onload = () => {
      scriptLoaded = true;
      resolve();
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return scriptPromise;
}

function loadHolidays(): Promise<Set<string>> {
  if (holidaysCache) return Promise.resolve(holidaysCache);
  return fetch("/holiday.csv")
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    })
    .then((text) => {
      const set = new Set<string>();
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^(\d{4}\/\d{1,2}\/\d{1,2})/);
        if (m) set.add(m[1]);
      }
      holidaysCache = set;
      return set;
    })
    .catch(() => {
      holidaysCache = new Set();
      return holidaysCache;
    });
}

interface DatePickerInputProps {
  value: string; // "YYYY-MM-DD" or ""
  onChange: (value: string) => void;
  placeholder?: string;
  title?: string;
  className?: string;
}

export function DatePickerInput({
  value,
  onChange,
  placeholder = t("common:datePlaceholder"),
  title,
  className = "",
}: DatePickerInputProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handleChange = useCallback((e: Event) => {
    const input = e.target as HTMLInputElement;
    const val = input.value; // "YYYY/MM/DD"
    if (!val) {
      onChangeRef.current("");
      return;
    }
    // Convert "YYYY/MM/DD" to "YYYY-MM-DD" for the API
    const converted = val.replace(/\//g, "-");
    onChangeRef.current(converted);
  }, []);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    let destroyed = false;

    Promise.all([loadDatePickerScript(), loadHolidays()]).then(
      ([, holidays]) => {
        if (destroyed || !wrapper || !window.DatePicker) return;

        // Prevent auto-init from re-creating
        const input = wrapper.querySelector(".date-input") as HTMLInputElement;
        if (!input) return;

        const dp = new window.DatePicker.DatePicker(wrapper, {
          format: "YYYY/MM/DD",
          holidays,
        });
        pickerRef.current = dp;

        // Set initial value if provided
        if (value) {
          const parts = value.split("-");
          if (parts.length === 3) {
            input.value = `${parts[0]}/${parts[1]}/${parts[2]}`;
            dp.selectedDate = new Date(
              parseInt(parts[0]),
              parseInt(parts[1]) - 1,
              parseInt(parts[2]),
            );
            dp.viewDate = new Date(dp.selectedDate);
          }
        }

        input.addEventListener("change", handleChange);
      },
    );

    return () => {
      destroyed = true;
      const input = wrapper.querySelector(".date-input") as HTMLInputElement;
      if (input) input.removeEventListener("change", handleChange);
      if (pickerRef.current) {
        pickerRef.current.destroy();
        pickerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes
  useEffect(() => {
    if (!wrapperRef.current || !pickerRef.current) return;
    const input = wrapperRef.current.querySelector(
      ".date-input",
    ) as HTMLInputElement;
    if (!input) return;

    if (!value) {
      input.value = "";
      pickerRef.current.selectedDate = null;
      return;
    }
    const parts = value.split("-");
    if (parts.length === 3) {
      const display = `${parts[0]}/${parts[1]}/${parts[2]}`;
      if (input.value !== display) {
        input.value = display;
        pickerRef.current.selectedDate = new Date(
          parseInt(parts[0]),
          parseInt(parts[1]) - 1,
          parseInt(parts[2]),
        );
        pickerRef.current.viewDate = new Date(
          pickerRef.current.selectedDate,
        );
      }
    }
  }, [value]);

  return (
    <div ref={wrapperRef} className={`date-picker-wrapper ${className}`} title={title}>
      <input
        type="text"
        className="date-input"
        placeholder={placeholder}
        readOnly
      />
    </div>
  );
}
