import Link from 'next/link';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@project-x/ui';
import { APP_NAME } from '@project-x/shared';

export default function HomePage() {
  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center px-6 py-16">
        <p className="mb-3 text-sm font-medium uppercase tracking-[0.2em] text-slate-500">
          {APP_NAME}
        </p>
        <h1 className="mb-4 text-4xl font-semibold tracking-tight text-slate-900">
          Dashboard foundation
        </h1>
        <p className="mb-10 max-w-2xl text-lg text-slate-600">
          Day 1 scaffolding is ready. Authentication and product features arrive in later sprints.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">Login</CardTitle>
              <CardDescription>Placeholder auth screen — no real auth yet.</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/login">
                <Button>Open login</Button>
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-xl">App shell</CardTitle>
              <CardDescription>Basic dashboard layout placeholder.</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/app">
                <Button variant="secondary">Open dashboard</Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
