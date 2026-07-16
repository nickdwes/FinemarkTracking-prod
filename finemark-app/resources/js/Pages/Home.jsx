import DashboardLayout from '@/Layouts/DashboardLayout';

export default function Home({ appName }) {
    const menuItems = [
        { label: 'Overview', href: '#' },
        { label: 'Setup', href: '#' },
        { label: 'Docs', href: '#' },
    ];

    return (
        <DashboardLayout title="Home" roleLabel="Welcome" menuItems={menuItems}>
            <div className="space-y-6">
                <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
                    <h2 className="text-3xl font-semibold">Welcome to {appName}</h2>
                    <p className="mt-2 text-slate-600">
                        Your Laravel 10 + Inertia.js + React starter is ready.
                    </p>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                    <div className="rounded-lg border border-slate-200 bg-white p-5">
                        <h3 className="text-lg font-semibold">Postgres</h3>
                        <p className="mt-1 text-sm text-slate-600">Configured via .env</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-5">
                        <h3 className="text-lg font-semibold">Redis</h3>
                        <p className="mt-1 text-sm text-slate-600">Cache + queue ready</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-5">
                        <h3 className="text-lg font-semibold">S3</h3>
                        <p className="mt-1 text-sm text-slate-600">Compatible storage config</p>
                    </div>
                </div>
            </div>
        </DashboardLayout>
    );
}
