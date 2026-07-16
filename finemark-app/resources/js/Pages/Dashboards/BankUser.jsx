import DashboardLayout from '@/Layouts/DashboardLayout';

export default function BankUser() {
    const menuItems = [
        { label: 'Finance Requests', href: '#' },
        { label: 'Statements', href: '#' },
        { label: 'Compliance', href: '#' },
        { label: 'Releases', href: '#' },
    ];

    return (
        <DashboardLayout title="Bank User Dashboard" roleLabel="Bank User" menuItems={menuItems}>
            <p className="text-sm text-slate-600">
                Review financing requests, statements, and compliance checks.
            </p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">New Requests</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">--</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">In Review</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">--</div>
                </div>
            </div>
        </DashboardLayout>
    );
}
