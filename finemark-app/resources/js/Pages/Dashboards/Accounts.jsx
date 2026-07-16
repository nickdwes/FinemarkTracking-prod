import DashboardLayout from '@/Layouts/DashboardLayout';

export default function Accounts() {
    const menuItems = [
        { label: 'Billing', href: '#' },
        { label: 'Payments', href: '#' },
        { label: 'Reconciliation', href: '#' },
        { label: 'Reports', href: '#' },
    ];

    return (
        <DashboardLayout title="Accounts Dashboard" roleLabel="Accounts" menuItems={menuItems}>
            <p className="text-sm text-slate-600">Monitor billing, track payments, and reconcile accounts.</p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">Outstanding</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">--</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">Paid Today</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">--</div>
                </div>
            </div>
        </DashboardLayout>
    );
}
