import "./globals.css";
import type { ReactNode } from "react";

const title = process.env.GUESTBOOK_TITLE ?? "Guestbook";

export const metadata = {
  title,
  description: "A little guestbook, live on the internet.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title, statusBarStyle: "default" as const },
};

export const viewport = {
  themeColor: "#e0644b",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
