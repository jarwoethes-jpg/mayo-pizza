/** The views shown while a downloader is proving room access. */
export type PasswordPromptView =
  | "password-required"
  | "password-wrong"
  | "password-locked";

/** Password prompt state intentionally excludes file metadata. */
export interface PasswordPromptState {
  view: PasswordPromptView;
  attemptsRemaining?: number;
}

/** Server-driven transitions for password prompt presentation. */
export type PasswordPromptEvent =
  | { type: "required" }
  | { type: "wrong"; attemptsRemaining?: number }
  | { type: "locked" };

/** Converts password server responses into the small set of prompt views. */
export const passwordPromptReducer = (
  _state: PasswordPromptState | undefined,
  event: PasswordPromptEvent,
): PasswordPromptState => {
  if (event.type === "required") {
    return { view: "password-required" };
  }
  if (event.type === "locked") {
    return { view: "password-locked" };
  }
  return {
    view: "password-wrong",
    ...(event.attemptsRemaining === undefined
      ? {}
      : { attemptsRemaining: event.attemptsRemaining }),
  };
};

/** The two pieces of copy needed by a password prompt view. */
export interface PasswordPromptCopy {
  heading: string;
  message: string;
}

/** Returns brand-voice copy without inventing an attempt count. */
export const getPasswordPromptCopy = (
  state: PasswordPromptState,
): PasswordPromptCopy => {
  if (state.view === "password-required") {
    return {
      heading: "A password keeps this slice tucked away.",
      message:
        "Enter the password from the sender before we show what’s inside.",
    };
  }
  if (state.view === "password-locked") {
    return {
      heading: "This room is locked.",
      message:
        "That room has taken five wrong turns. Ask the sender for a fresh room and we’ll try again.",
    };
  }
  return {
    heading: "That password missed the crust.",
    message:
      state.attemptsRemaining === undefined
        ? "That password did not match. Try the sender’s password again."
        : `That password did not match. You have ${state.attemptsRemaining} ${state.attemptsRemaining === 1 ? "try" : "tries"} left.`,
  };
};
