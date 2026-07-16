import DashboardLayout from '@/Layouts/DashboardLayout';

export default function SuperAdmin() {
    const menuItems = [
        { label: 'User Management', href: '#' },
        { label: 'Roles & Permissions', href: '#' },
        { label: 'System Settings', href: '#' },
        { label: 'Audit Logs', href: '#' },
    ];

    return (
        <DashboardLayout title="Super Admin Dashboard" roleLabel="Super Admin" menuItems={menuItems}>
            <p className="text-sm text-slate-600">
                Administer users, configure systems, and monitor audit trails.
            </p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">Active Users</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">--</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">System Alerts</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">--</div>
                </div>
            </div>
        </DashboardLayout>
    );
}
