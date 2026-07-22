import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@project-x/ui';

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <p className="mt-1 text-sm text-slate-500">Placeholder settings page.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Account</CardTitle>
          <CardDescription>
            Configuration will be available after authentication ships.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600">Nothing to configure in Day 1.</p>
        </CardContent>
      </Card>
    </div>
  );
}
