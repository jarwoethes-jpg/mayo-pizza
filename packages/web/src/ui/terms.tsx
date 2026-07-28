import { LegalPage } from "./legal";

/** Mayo’s published abuse-reporting address. */
export const ABUSE_CONTACT = "abuse@mayo.pizza";

/** The short terms statements rendered on the terms route. */
export const TERMS_COPY = [
  "Please use mayo.pizza for lawful sharing only. Do not send illegal content, malware, or anything that harms other people.",
  "We may withdraw the service or the relay when safety, capacity, or the law requires it.",
  "The service is provided as-is, without a warranty that every transfer, relay, or room will be available or error-free.",
] as const;

/** Renders the short service terms and abuse-reporting route. */
export const TermsPage = () => (
  <LegalPage title="Terms & abuse">
    {TERMS_COPY.map((paragraph) => (
      <p key={paragraph}>{paragraph}</p>
    ))}
    <p>
      To report abuse, contact <strong>{ABUSE_CONTACT}</strong> with the room
      details and a clear description of the issue.
    </p>
  </LegalPage>
);
