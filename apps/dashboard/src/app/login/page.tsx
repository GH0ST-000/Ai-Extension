import Link from 'next/link';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@project-x/ui';
import { APP_NAME } from '@project-x/shared';

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{APP_NAME}</CardTitle>
          <CardDescription>Login placeholder — authentication is not wired yet.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" action="/app">
            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium text-slate-700">
                Email
              </label>
              <Input id="email" name="email" type="email" placeholder="you@company.com" disabled />
            </div>
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium text-slate-700">
                Password
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                placeholder="••••••••"
                disabled
              />
            </div>
            <Button className="w-full" disabled type="submit">
              Sign in (coming soon)
            </Button>
            <p className="text-center text-sm text-slate-500">
              <Link href="/app" className="underline underline-offset-4 hover:text-slate-800">
                Continue to dashboard shell
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
