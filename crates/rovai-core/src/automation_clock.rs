//! Host-owned schedule time. A delayed executor tick is not a device wake.
use chrono::{DateTime, Utc};

pub(crate) struct AutomationClock {
    recovery_boundary: DateTime<Utc>,
    sleep_offset: Option<u64>,
}

impl AutomationClock {
    pub(crate) fn start() -> Self {
        Self {
            recovery_boundary: Utc::now(),
            sleep_offset: sleep_offset_bounds().map(|(_, upper)| upper),
        }
    }

    pub(crate) fn tick(&mut self) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
        // Capture before sampling: sleep during sampling must never turn an
        // in-flight pre-sleep timestamp into a post-wake overdue claim.
        let now = Utc::now();
        let sample = sleep_offset_bounds();
        self.observe(now, Utc::now(), sample)
    }

    fn observe(
        &mut self,
        now: DateTime<Utc>,
        observed_at: DateTime<Utc>,
        sample: Option<(u64, u64)>,
    ) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
        let (lower, upper) = sample?;
        match self.sleep_offset {
            // A millisecond tolerance excludes clock-read rounding. Neither
            // wall-clock changes nor ordinary scheduler delay changes this gap.
            Some(previous) if lower > previous.saturating_add(1_000_000) => {
                self.recovery_boundary = self.recovery_boundary.max(observed_at);
                self.sleep_offset = Some(upper);
                return None;
            }
            Some(previous) => self.sleep_offset = Some(previous.min(upper)),
            None => {
                // If startup could not sample, establish the boundary only once
                // a bounded native observation is available.
                self.recovery_boundary = self.recovery_boundary.max(observed_at);
                self.sleep_offset = Some(upper);
                return None;
            }
        }
        Some((now, self.recovery_boundary))
    }
}

#[cfg(target_os = "macos")]
fn sleep_offset_bounds() -> Option<(u64, u64)> {
    use std::sync::OnceLock;
    static TIMEBASE: OnceLock<Option<(u32, u32)>> = OnceLock::new();
    #[repr(C)]
    struct TimebaseInfo {
        numer: u32,
        denom: u32,
    }
    unsafe extern "C" {
        fn mach_timebase_info(info: *mut TimebaseInfo) -> i32;
        fn mach_absolute_time() -> u64;
        fn mach_continuous_time() -> u64;
    }
    let (numer, denom) = (*TIMEBASE.get_or_init(|| {
        let mut info = TimebaseInfo { numer: 0, denom: 0 };
        // SAFETY: the OS writes one initialized, correctly sized timebase record.
        let status = unsafe { mach_timebase_info(&mut info) };
        (status == 0 && info.numer > 0 && info.denom > 0).then_some((info.numer, info.denom))
    }))?;
    // Apple's mach_time.h specifies that continuous time includes sleep, while
    // absolute time excludes it. Bracket the read to bound scheduling noise.
    // SAFETY: these process-independent OS clock functions take no pointers.
    let (before, continuous, after) = unsafe {
        let before = mach_absolute_time();
        let continuous = mach_continuous_time();
        (before, continuous, mach_absolute_time())
    };
    let nanos = |ticks: u64| -> Option<u64> {
        ((ticks as u128 * numer as u128) / denom as u128)
            .try_into()
            .ok()
    };
    if nanos(after.checked_sub(before)?)? > 1_000_000 {
        // Contended/suspended sampling skips one claim instead of guessing wake.
        return None;
    }
    Some((
        nanos(continuous.saturating_sub(after))?,
        nanos(continuous.checked_sub(before)?)?,
    ))
}

#[cfg(not(target_os = "macos"))]
fn sleep_offset_bounds() -> Option<(u64, u64)> {
    // Desktop supplies explicit native suspend/resume control on other OSes.
    // Standalone wake qualification there is tracked separately from macOS.
    Some((0, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Owns the new native clock seam without SQLite or real sleeping: a long
    // executor delay/NTP adjustment cannot discard due occurrences, real wake
    // advances once, and uncertain sampling cannot admit a stale claim.
    #[test]
    fn only_observed_sleep_advances_recovery_boundary() {
        let start = DateTime::parse_from_rfc3339("2026-09-13T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut clock = AutomationClock {
            recovery_boundary: start,
            sleep_offset: Some(100),
        };
        let delayed = start + chrono::Duration::hours(2);
        assert_eq!(
            clock.observe(delayed, delayed, Some((90, 110))),
            Some((delayed, start))
        );
        assert_eq!(clock.observe(delayed, delayed, None), None);
        assert_eq!(clock.recovery_boundary, start);
        let resumed = delayed + chrono::Duration::minutes(30);
        assert_eq!(
            clock.observe(resumed, resumed, Some((2_000_000, 2_000_010))),
            None
        );
        let next = resumed + chrono::Duration::minutes(1);
        assert_eq!(
            clock.observe(next, next, Some((2_000_000, 2_000_009))),
            Some((next, resumed))
        );
        assert_eq!(
            clock.observe(start, start, Some((2_000_000, 2_000_009))),
            Some((start, resumed))
        );
        assert_eq!(
            clock.observe(start, next, Some((4_000_000, 4_000_010))),
            None
        );
        assert_eq!(clock.recovery_boundary, next);
        clock.sleep_offset = None;
        assert_eq!(clock.observe(next, next, None), None);
        assert_eq!(
            clock.observe(next, next, Some((2_000_000, 2_000_009))),
            None
        );
    }
}
