import DashboardLayout from '@/Layouts/DashboardLayout';

export default function CertificateAdmin() {
    const menuItems = [
        { label: 'Issuance Queue', href: '#' },
        { label: 'Certificates', href: '#' },
        { label: 'Templates', href: '#' },
        { label: 'Verification', href: '#' },
    ];

    return (
        <DashboardLayout title="Certificate Admin Dashboard" roleLabel="Certificate Admin" menuItems={menuItems}>
            <p className="text-sm text-slate-600">
                Issue, manage, and verify certificates with the latest templates.
            </p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">Pending Certificates</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">--</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">Issued Today</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">--</div>
                </div>
            </div>
        </DashboardLayout>
    );
}
