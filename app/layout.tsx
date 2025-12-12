import './globals.css';

export const metadata = {
  title: 'Runbook Copilot',
  description: 'AI-powered runbook assistant',
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
