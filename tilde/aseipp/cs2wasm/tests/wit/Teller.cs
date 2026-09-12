// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The module side of world `teller` in ledger.wit: it uses the accounts
// `bank` exports through their imported class.
using System.Threading.Tasks;

namespace Test.Ledger;

public static partial class Teller
{
    public static partial async Task<string> Run()
    {
        var ann = new Books.Account("ann");
        ann.Deposit(5);
        var bob = Books.Account.Open("bob", 7);
        uint both = Books.Combined(ann, bob);
        ann.Absorb(bob);
        uint audited = await ann.Audit();
        string before = string.Join(",", Books.Closed());
        string statement = ann.Statement();
        ann.Dispose();
        string after = string.Join(",", Books.Closed());
        return both + "|" + audited + "|" + statement + "|" + before + "|" + after;
    }
}
