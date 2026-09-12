// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The module side of world `bank` in ledger.wit: the accounts another
// component holds handles of.
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Test.Ledger;

public static partial class Bank
{
    public static partial class Books
    {
        public static partial uint Combined(Account a, Account b) => a.Balance + b.Balance;

        public static partial string[] Closed() => Account.ClosedOwners.ToArray();

        public sealed partial class Account
        {
            internal static readonly List<string> ClosedOwners = new List<string>();
            private readonly string owner;
            internal uint Balance;

            public partial Account(string owner) => this.owner = owner;

            public partial uint Deposit(uint amount) => Balance += amount;

            public partial async Task<uint> Audit()
            {
                await Task.Yield();
                return Balance;
            }

            public partial string Statement() => owner + ":" + Balance;

            public partial void Absorb(Account other)
            {
                Balance += other.Balance;
                other.Balance = 0;
            }

            internal static partial Account Open(string owner, uint amount) => new Account(owner) { Balance = amount };

            partial void OnDropped() => ClosedOwners.Add(owner);
        }
    }
}
