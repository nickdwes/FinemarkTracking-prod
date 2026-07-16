<?php

namespace App\Policies;

use App\Models\User;

class RolePolicy
{
    /**
     * @param  array<int, string>  $roles
     */
    public function accessAny(User $user, array $roles): bool
    {
        if ($user->role === User::ROLE_SUPER_ADMIN) {
            return true;
        }

        return in_array($user->role, $roles, true);
    }

    public function access(User $user, string $role): bool
    {
        if ($user->role === User::ROLE_SUPER_ADMIN) {
            return true;
        }

        return $user->role === $role;
    }
}
