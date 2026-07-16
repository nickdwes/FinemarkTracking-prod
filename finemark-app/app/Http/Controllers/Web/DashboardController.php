<?php

namespace App\Http\Controllers\Web;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\RedirectResponse;
use Inertia\Inertia;
use Inertia\Response;

class DashboardController extends Controller
{
    public function index(): RedirectResponse
    {
        return redirect()->route($this->dashboardRouteFor(auth()->user()?->role));
    }

    public function sales(): Response
    {
        return Inertia::render('Dashboards/Sales');
    }

    public function technician(): Response
    {
        return Inertia::render('Dashboards/Technician');
    }

    public function technicalOfficer(): Response
    {
        return Inertia::render('Dashboards/TechnicalOfficer');
    }

    public function certificateAdmin(): Response
    {
        return Inertia::render('Dashboards/CertificateAdmin');
    }

    public function accounts(): Response
    {
        return Inertia::render('Dashboards/Accounts');
    }

    public function bankUser(): Response
    {
        return Inertia::render('Dashboards/BankUser');
    }

    public function superAdmin(): Response
    {
        return Inertia::render('Dashboards/SuperAdmin');
    }

    private function dashboardRouteFor(?string $role): string
    {
        return match ($role) {
            User::ROLE_TECHNICIAN => 'dashboard.technician',
            User::ROLE_TECHNICAL_OFFICER => 'dashboard.technical_officer',
            User::ROLE_CERTIFICATE_ADMIN => 'dashboard.certificate_admin',
            User::ROLE_ACCOUNTS => 'dashboard.accounts',
            User::ROLE_BANK_USER => 'dashboard.bank_user',
            User::ROLE_SUPER_ADMIN => 'dashboard.super_admin',
            default => 'dashboard.sales',
        };
    }
}
