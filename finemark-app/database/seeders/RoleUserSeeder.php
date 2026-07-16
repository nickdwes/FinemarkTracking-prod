<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class RoleUserSeeder extends Seeder
{
    public function run(): void
    {
        $roles = User::roles();

        foreach ($roles as $role) {
            User::updateOrCreate(
                ['email' => $role.'@finemark.test'],
                [
                    'name' => ucfirst(str_replace('_', ' ', $role)),
                    'password' => Hash::make('password'),
                    'role' => $role,
                ]
            );
        }
    }
}
