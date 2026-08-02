import type { ReactNode } from "react";

interface LegalPageProps {
  title: string;
  children: ReactNode;
}

/** Provides the shared legal-page frame and navigation. */
export const LegalPage = ({ title, children }: LegalPageProps) => (
  <main className="app-shell legal-shell">
    <article className="room-card legal-card">
      <header className="brand-hero">
        <a href="/" aria-label="mayo.pizza home">
          <img
            className="brand-mark"
            src="/brand/logo-mark.svg"
            alt="mayo.pizza pizza portrait"
          />
        </a>
        <p className="wordmark">mayo.pizza</p>
        <p className="tagline">Secure. Fast. Shared.</p>
      </header>
      <div className="legal-copy mt-8">
        <h1 className="view-heading">{title}</h1>
        {children}
      </div>
      <footer className="legal-footer">
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms &amp; abuse</a>
      </footer>
    </article>
  </main>
);

/** The privacy statements rendered on the privacy route. */
export const PRIVACY_COPY = [
  "On the peer-to-peer path, file bytes never touch our signaling server.",
  "Our signaling server sees room slugs, peer IDs, and IP addresses. It never sees filenames or file contents.",
  "If a connection falls back to TURN, encrypted bytes do transit our coturn server. They are DTLS-encrypted and unreadable to us, but they are traffic through our box, and we say so plainly.",
  "We retain signaling access logs for 7 days. Those logs contain no filenames and no slugs.",
  "Rooms hold only a slug, timestamps, and hashes — never file data. They survive a server restart and expire after 24 idle hours.",
] as const;

/** Renders the plain-language privacy stance. */
export const PrivacyPage = () => (
  <LegalPage title="Privacy, plainly">
    {PRIVACY_COPY.map((paragraph) => (
      <p key={paragraph}>{paragraph}</p>
    ))}
  </LegalPage>
);
