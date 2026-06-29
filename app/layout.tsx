import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NFL Projection Accuracy Dashboard",
  description:
    "Compare projected ranges (Floor/Median/Ceiling) to actual results across volume and efficiency stats.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
