// Public presentation only. Local CLI/stdio identity and interview protocol are unchanged.
export const HOSTED_TITLE = "Grill-me Game";
export const HOSTED_DESCRIPTION = "Turn an idea into a friendly swipe-card interview. Answer in chat or on your phone, one focused round at a time.";
export const hostedServerInfo = version => ({
  name: "grill-me-game", title: HOSTED_TITLE, version,
  description: HOSTED_DESCRIPTION, websiteUrl: "https://grill-me.ai/",
  icons: [{ src: "https://grill-me.ai/grill-me-game.svg", mimeType: "image/svg+xml", sizes: ["128x128"] }],
});

export const HOSTED_TOOL_TITLES = Object.freeze({
  grill_start: "Start an interview",
  grill_send: "Send the next questions",
  grill_wait: "Collect answers",
  grill_ack: "Confirm answers received",
  grill_finish: "Finish the interview",
  grill_cancel: "Cancel the interview",
  grill_subscribe: "Connect an automation",
  grill_unsubscribe: "Disconnect an automation",
  grill_show: "Show swipe cards",
  grill_ui_state: "Check the current round",
  grill_ui_submit: "Submit card answers",
});
