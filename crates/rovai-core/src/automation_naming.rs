//! Formatting at occurrence admission. The resulting Thread title is stored once.
use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationDateFormat {
    #[default]
    Iso,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum AutomationTimeFormat {
    #[default]
    #[serde(rename = "24")]
    TwentyFour,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationDatePosition {
    Prefix,
    #[default]
    Suffix,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationThreadNaming {
    pub include_date: bool,
    pub include_time: bool,
    pub date_format: AutomationDateFormat,
    pub time_format: AutomationTimeFormat,
    pub position: AutomationDatePosition,
}

impl Default for AutomationThreadNaming {
    fn default() -> Self {
        Self {
            include_date: true,
            include_time: true,
            date_format: AutomationDateFormat::Iso,
            time_format: AutomationTimeFormat::TwentyFour,
            position: AutomationDatePosition::Suffix,
        }
    }
}

impl AutomationThreadNaming {
    pub(crate) fn is_default(&self) -> bool {
        self == &Self::default()
    }

    pub fn title(&self, name: &str, at: DateTime<FixedOffset>) -> String {
        let mut parts = Vec::with_capacity(2);
        if self.include_date {
            parts.push(at.format("%Y-%m-%d").to_string());
        }
        if self.include_time {
            parts.push(at.format("%H:%M").to_string());
        }
        if parts.is_empty() {
            return name.to_string();
        }
        let stamp = parts.join(" ");
        match self.position {
            AutomationDatePosition::Prefix => format!("{stamp} · {name}"),
            AutomationDatePosition::Suffix => format!("{name} · {stamp}"),
        }
    }
}

/// Desktop-only settings do not expand the existing Agent CLI output contract.
pub(crate) fn without_desktop_settings(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(object) = value.as_object_mut() {
        object.remove("threadNaming");
        if let Some(items) = object.get_mut("automations").and_then(|v| v.as_array_mut()) {
            for item in items {
                if let Some(item) = item.as_object_mut() {
                    item.remove("threadNaming");
                }
            }
        }
        if let Some(payload) = object.get_mut("payload").and_then(|v| v.as_object_mut()) {
            payload.remove("threadNaming");
        }
    }
    value
}
