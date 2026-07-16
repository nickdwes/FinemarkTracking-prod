<?php

namespace App\Models;

// use Illuminate\Contracts\Auth\MustVerifyEmail;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable
{
    use HasApiTokens, HasFactory, HasUuids, Notifiable;

    public $incrementing = false;

    protected $keyType = 'string';

    public const ROLE_SALES = 'sales';
    public const ROLE_TECHNICIAN = 'technician';
    public const ROLE_TECHNICAL_OFFICER = 'technical_officer';
    public const ROLE_CERTIFICATE_ADMIN = 'certificate_admin';
    public const ROLE_ACCOUNTS = 'accounts';
    public const ROLE_BANK_USER = 'bank_user';
    public const ROLE_SUPER_ADMIN = 'super_admin';

    /**
     * The attributes that are mass assignable.
     *
     * @var array<int, string>
     */
    protected $fillable = [
        'name',
        'email',
        'password',
        'role',
        'two_factor_enabled',
        'two_factor_method',
    ];

    /**
     * The attributes that should be hidden for serialization.
     *
     * @var array<int, string>
     */
    protected $hidden = [
        'password',
        'remember_token',
    ];

    /**
     * The attributes that should be cast.
     *
     * @var array<string, string>
     */
    protected $casts = [
        'email_verified_at' => 'datetime',
        'password' => 'hashed',
        'two_factor_enabled' => 'boolean',
    ];

    /**
     * @return array<int, string>
     */
    public static function roles(): array
    {
        return [
            self::ROLE_SALES,
            self::ROLE_TECHNICIAN,
            self::ROLE_TECHNICAL_OFFICER,
            self::ROLE_CERTIFICATE_ADMIN,
            self::ROLE_ACCOUNTS,
            self::ROLE_BANK_USER,
            self::ROLE_SUPER_ADMIN,
        ];
    }

    public function hasRole(string $role): bool
    {
        return $this->role === $role;
    }

    /**
     * @param array<int, string> $roles
     */
    public function hasAnyRole(array $roles): bool
    {
        return in_array($this->role, $roles, true);
    }
}
