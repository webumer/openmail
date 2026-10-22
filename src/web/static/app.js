const PRESETS = {
  migadu: {
    imap_host: "imap.migadu.com",
    imap_port: "993",
    imap_secure: true,
    smtp_host: "smtp.migadu.com",
    smtp_port: "465",
    smtp_secure: true,
    smtp_starttls: false,
  },
  fastmail: {
    imap_host: "imap.fastmail.com",
    imap_port: "993",
    imap_secure: true,
    smtp_host: "smtp.fastmail.com",
    smtp_port: "465",
    smtp_secure: true,
    smtp_starttls: false,
  },
  icloud: {
    imap_host: "imap.mail.me.com",
    imap_port: "993",
    imap_secure: true,
    smtp_host: "smtp.mail.me.com",
    smtp_port: "587",
    smtp_secure: false,
    smtp_starttls: true,
  },
  gmail: {
    imap_host: "imap.gmail.com",
    imap_port: "993",
    imap_secure: true,
    smtp_host: "smtp.gmail.com",
    smtp_port: "465",
    smtp_secure: true,
    smtp_starttls: false,
  },
};

const HOST_FIELDS = ["imap_host", "imap_port", "smtp_host", "smtp_port"];
const CHECK_FIELDS = ["imap_secure", "smtp_secure", "smtp_starttls"];

function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error("Missing field");
  return element;
}

function zohoPreset(region) {
  const suffix = region === "eu" || region === "in" ? region : "com";
  return {
    imap_host: "imap.zoho." + suffix,
    imap_port: "993",
    imap_secure: true,
    smtp_host: "smtp.zoho." + suffix,
    smtp_port: "465",
    smtp_secure: true,
    smtp_starttls: false,
  };
}

function applyPreset() {
  const preset = byId("preset");
  const region = byId("zoho_region");
  const custom = preset.value === "custom";
  region.disabled = preset.value !== "zoho";
  const security = document.getElementById("smtp_security");
  if (custom) {
    for (const id of HOST_FIELDS) byId(id).readOnly = false;
    for (const id of CHECK_FIELDS) {
      const field = document.getElementById(id);
      if (field) field.disabled = false;
    }
    if (security) security.disabled = false;
    return;
  }
  const values = preset.value === "zoho" ? zohoPreset(region.value) : PRESETS[preset.value];
  if (!values) return;
  for (const id of HOST_FIELDS) {
    const field = byId(id);
    field.value = values[id];
    field.readOnly = true;
  }
  for (const id of CHECK_FIELDS) {
    const field = document.getElementById(id);
    if (!field) continue;
    field.checked = values[id] === true;
    field.disabled = true;
  }
  if (security) {
    security.value = values.smtp_starttls ? "starttls" : "tls";
    security.disabled = true;
  }
}

const preset = document.getElementById("preset");
const region = document.getElementById("zoho_region");
if (preset && region) {
  preset.addEventListener("change", applyPreset);
  region.addEventListener("change", applyPreset);
  applyPreset();
}
